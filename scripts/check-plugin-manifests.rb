#!/usr/bin/env ruby
# frozen_string_literal: true
#
# Verify every plugin manifest parses and that each marketplace entry resolves to a real plugin.
#
# Guards the class of bug where a hand-edited manifest — a trailing comma, or a `plugins[].source`
# pointing at a directory that has since moved — ships green and fails at `/plugin install` time for a
# user. Nothing in CI parsed these files before; `check-skill-frontmatter.rb` gates the *skills*, and
# this gates the *manifests* that ship them.
#
# Checks, per manifest:
#   1. the file is parseable JSON;
#   2. `marketplace.json` entries carry a name, and their `source` directory exists and contains a
#      parseable `.claude-plugin/plugin.json`;
#   3. the marketplace entry's name matches the resolved plugin's name (a mismatch breaks install);
#   4. every `plugin.json` carries a non-empty `name`.

require "json"
require "pathname"

# FNM_DOTMATCH governs whether the `**` wildcard descends into dot-prefixed DIRECTORIES; the literal
# `.claude-plugin` in the pattern matches with or without it. It is here for the nested case — a plugin
# vendored under something like `.claude/` — which `**` would otherwise walk straight past, the same
# reason check-skill-frontmatter.rb sets it.
#
# The abort on an empty result is the load-bearing part: a glob that silently stops matching would make
# this script report success while checking zero files, which is the same vacuous-pass failure it exists
# to catch.
manifests = Dir.glob("**/.claude-plugin/*.json", File::FNM_DOTMATCH)
                .reject { |f| f.split(File::SEPARATOR).any? { |seg| seg == "node_modules" || seg == ".git" } }
                .sort
abort("::error::no .claude-plugin/*.json manifests found — did the glob stop matching?") if manifests.empty?

failed = []

# Parse once, keep the result: later checks resolve marketplace sources against these.
parsed = {}
manifests.each do |f|
  parsed[f] = JSON.parse(File.read(f, encoding: "UTF-8"))
rescue JSON::ParserError => e
  failed << "#{f}: not valid JSON — #{e.message.lines.first.to_s.strip}"
end

parsed.each do |f, data|
  unless data.is_a?(Hash)
    failed << "#{f}: top level is not a JSON object"
    next
  end

  if File.basename(f) == "marketplace.json"
    # Sources are repo-root-relative, and the manifest sits at <root>/.claude-plugin/marketplace.json,
    # so the root is two levels up from the file.
    root = File.dirname(File.dirname(f))
    entries = data["plugins"]
    unless entries.is_a?(Array)
      failed << "#{f}: `plugins` must be an array"
      next
    end

    entries.each_with_index do |entry, i|
      label = "#{f}: plugins[#{i}]"
      unless entry.is_a?(Hash)
        failed << "#{label} is not an object"
        next
      end
      name = entry["name"].to_s.strip
      failed << "#{label}: missing or empty `name`" if name.empty?

      source = entry["source"]
      # Non-path sources (the git/GitHub object form, or a URL) are a documented plugin-spec option and
      # cannot be resolved on disk. Skip rather than fail, so adding a remote source later does not
      # break this gate.
      next unless source.is_a?(String) && !source.include?("://")

      # cleanpath keeps reported paths repo-relative; absolute paths bury the useful part of the
      # message under the runner's checkout directory in CI logs.
      dir = Pathname.new(File.join(root, source)).cleanpath.to_s
      unless File.directory?(dir)
        failed << "#{label}: source #{source.inspect} does not exist (resolved to #{dir})"
        next
      end

      plugin_manifest = File.join(dir, ".claude-plugin", "plugin.json")
      unless File.file?(plugin_manifest)
        failed << "#{label}: source #{source.inspect} has no .claude-plugin/plugin.json — " \
                  "`/plugin install` would fail"
        next
      end

      # Reuse the parse from above when the glob already covered this file, so a syntax error is
      # reported once against the file itself rather than again for every entry referencing it. A
      # globbed file missing from `parsed` is one that already failed to parse — skip it silently
      # rather than re-reporting the same defect under a second message.
      plugin = parsed[plugin_manifest]
      if plugin.nil?
        next if manifests.include?(plugin_manifest)

        begin
          plugin = JSON.parse(File.read(plugin_manifest, encoding: "UTF-8"))
        rescue JSON::ParserError => e
          failed << "#{label}: #{plugin_manifest} is not valid JSON — #{e.message.lines.first.to_s.strip}"
          next
        end
      end

      plugin_name = plugin.is_a?(Hash) ? plugin["name"].to_s.strip : ""
      if !name.empty? && !plugin_name.empty? && name != plugin_name
        failed << "#{label}: name #{name.inspect} does not match #{plugin_manifest} name " \
                  "#{plugin_name.inspect} — `/plugin install` resolves by name"
      end
    end
  end

  if File.basename(f) == "plugin.json" && data["name"].to_s.strip.empty?
    failed << "#{f}: missing or empty `name`"
  end
end

if failed.empty?
  puts "OK: #{manifests.length} plugin manifest(s) parse and every marketplace entry resolves."
else
  failed.each { |m| puts "::error::#{m}" }
  abort("#{failed.length} plugin manifest problem(s)")
end
