# Antigravity for Copilot

Use your Google Antigravity models (Gemini 3.8 Flash, Gemini 3.1 Pro and the rest of your account's catalog) in GitHub Copilot Chat. Requests go through Google's official Antigravity ACP server, the same one Zed and JetBrains install from the [ACP registry](https://agentclientprotocol.com/get-started/registry), running unmodified on your machine. Sign-in happens on Google's own page and the server keeps the tokens; this extension never sees them.

1. Pick an Antigravity model in the Copilot Chat model picker. The first time, the extension downloads the server (about 125 MB) and asks you to sign in with Google. **Antigravity: Manage** can switch to a Gemini or Vertex AI API key instead.
2. Set the thinking effort right in the picker.

Copilot keeps its own agent loop, tools, approvals and diffs. Its tools reach Antigravity over a local MCP bridge, and every tool call waits for Copilot's result however long it takes (Antigravity's own three-minute limit on tool calls doesn't apply, because the call is held at its permission step rather than on the wire). Antigravity's built-in edit and command tools are turned off, so changes show up in VS Code like any other Copilot edit; set `antigravityAcp.allowBuiltInTools` to let them run. Its read-only tools always work.

The server takes half a minute or more to start (it unpacks itself on every launch), so one process stays warm per window and every chat is a session in it. A finished chat keeps its session for 10 minutes (two at most); a running agent keeps it for as long as it takes. If the history no longer lines up (an edited message, summarization, a reload), a new session picks up from a replayed transcript. The server runs with its own Antigravity home, so your global Antigravity MCP servers, rules and skills stay out of Copilot's chats.

This is for using your own account for your own work. Google's [Antigravity terms](https://antigravity.google/terms) forbid using the service through third-party software that reuses its credentials; a Google moderator has said that running the official, unmodified binaries locally for a single user, with sign-in kept inside them, is supported, and points ACP editor integrations to this server. Don't run it as a shared service, and use an API key if you want to stay clear of the question entirely.

## Development

```sh
npm install
npm run compile   # type check + esbuild bundle
npm run lint      # includes a complexity cap of 8
npx -y knip       # unused files, exports and dependencies
npm run package   # builds the .vsix
```

Every push to `main` runs the same checks in GitHub Actions and attaches the `.vsix` to the release for the version in `package.json`.

Unofficial, not affiliated with Google. Antigravity and Gemini are trademarks of Google LLC.
