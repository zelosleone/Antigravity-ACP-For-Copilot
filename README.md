# Antigravity for Copilot

Use your Google Antigravity plan's Gemini models (Gemini 3.8 Flash, Gemini 3.1 Pro and the rest of your account's catalog) in GitHub Copilot Chat. Requests go through Google's official Antigravity ACP server, the same one Zed and JetBrains install from the [ACP registry](https://agentclientprotocol.com/get-started/registry), running unmodified on your machine. You sign in with Google on Google's own page and the server keeps the tokens; this extension never sees them.

1. Pick an Antigravity model in the Copilot Chat model picker. The first time, the extension downloads the server (about 125 MB) and asks you to sign in with Google.
2. Next to the model, pick the thinking effort and the permissions.

The server only offers its Claude and GPT-OSS models to clients it recognizes (Zed, JetBrains, Xcode), so Copilot gets the Gemini ones.

## Fast starts

Google's server is a PyInstaller one-file build that unpacks about 8,000 files into a new temp folder every time it starts, which takes half a minute. The extension unpacks them once per server version and starts the unchanged executable in PyInstaller's own already-unpacked mode, so the server is up in a few seconds. A session is also made ahead of time with your last model, so a new chat (or a subagent) starts without waiting for one. If a window crashes and leaves its server behind, the next start stops it.

## Permissions

Copilot's tools reach Antigravity over a local MCP bridge and always go through Copilot, with its own approvals and diffs. The **Permissions** option decides what happens with Antigravity's own built-in tools:

- **Copilot Tools** (default): its edit and command tools are declined, so changes show up as Copilot edits. Its read-only tools still work.
- **Ask**: a dialog asks before each of its edits and commands, with the server's own choices (Allow Always, Allow, Deny).
- **Auto Edit**: its file edits run without asking; commands still ask.
- **YOLO**: everything runs without asking. Antigravity can then edit files and run commands anywhere on your machine.

What it runs itself shows up in the chat (`> Ran npm test`, `> Edited src/app.ts`). Its own notes, plans and task lists live in its private home and are always allowed. Type `/plan <task>` to have it write an implementation plan and wait for your go-ahead.

## Sessions

Every tool call waits for Copilot's result however long it takes: Antigravity's own three-minute limit on tool calls doesn't apply, because the call is held at its permission step rather than on the wire. One server process runs per window and every chat is a session in it. A finished chat keeps its live session for 10 minutes (two at most); a running agent keeps it for as long as it takes. The server saves sessions for a week, so a chat that comes back later, even after a reload, resumes exactly where it was. Only when the history no longer lines up (an edited message, summarization) does a new session replay it as a transcript. The server runs with its own Antigravity home, so your global Antigravity MCP servers, rules and skills stay out of Copilot's chats.

In autopilot, Copilot ends a turn with its `task_complete` tool. Gemini tends to call it without writing any answer, so the first such call in a turn is sent back with a reminder to answer first.

This is for using your own account for your own work. Google's [Antigravity terms](https://antigravity.google/terms) forbid using the service through third-party software that reuses its credentials; a Google moderator has said that running the official, unmodified binaries locally for a single user, with sign-in kept inside them, is supported, and points ACP editor integrations to this server. Don't run it as a shared service.

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
