# Antigravity for Copilot

Use your Google Antigravity plan's models in GitHub Copilot Chat. Requests go through Google's official Antigravity ACP server, the one Zed and JetBrains install from the [ACP registry](https://agentclientprotocol.com/get-started/registry), running unmodified on your machine. You sign in on Google's own page and the server keeps the tokens.

1. Pick an Antigravity model in the Copilot Chat model picker. The first time, the extension downloads the server (about 125 MB) and asks you to sign in with Google.
2. Next to the model, pick the thinking effort and the permissions.

Models, effort levels and context windows all come from the server. Copilot keeps its own agent, tools, approvals and diffs; Gemini is the model behind them.

## Permissions

These decide what happens with Antigravity's own built-in tools; Copilot's tools always go through Copilot.

- **Copilot Tools** (default): Antigravity's edit, command, question and subagent tools are turned off, so changes show up as Copilot edits.
- **Ask**: it asks before each of its own edits and commands.
- **Auto Edit**: its file edits run without asking; commands still ask.
- **YOLO**: everything runs without asking, anywhere on your machine.

## Faster and lighter than the server on its own

Measured on Windows against the same server version, run the standard way:

| | Server as shipped | With this extension |
|---|---|---|
| Server start | about 28 s: it unpacks about 8,000 files on every launch | 3 to 5 s: unpacked once per version |
| New chat | waits 3 to 5 s for a new session | a session is ready ahead of time |
| Finished chats | each keeps its ~130 MB process until the server exits | the process is stopped |
| After an editor crash | the server keeps running | the next start stops it |
| VS Code in the background | everything keeps running | stops after 15 min, back on focus |

Tool calls never time out, however long Copilot takes, and chats resume where they left off after a reload. The extension is a single 67 KB file with no runtime dependencies.

## A message to Google

Thank you for publishing an official ACP server: it's what makes integrations like this one possible. A few changes would make it faster and lighter for every ACP client, and let us drop our workarounds:

1. **Start without unpacking.** The PyInstaller one-file build extracts about 8,000 files into a new temp folder on every launch, which takes about 30 seconds on Windows. A one-folder build would start in a few seconds.
2. **Support `session/close`.** Each session runs its own harness process (about 130 MB), and the server keeps all of them until it exits. Supporting ACP's `session/close` would let clients free them; today this extension has to find and stop them itself.
3. **Exit when stdin closes.** If a client crashes, the server keeps running in the background.
4. **List each model's context window** with the model options, not only in usage updates after the first reply.

## Your account

This is for your own account and your own work. Google's [Antigravity terms](https://antigravity.google/terms) don't allow third-party software that reuses its credentials; this extension runs Google's official binaries unmodified, with sign-in kept inside them, which a Google moderator has said is supported for a single user. Don't run it as a shared service.

## Development

```sh
npm install
npm run compile   # type check + esbuild bundle
npm run lint      # includes a complexity cap of 8
npx -y knip       # unused files, exports and dependencies
npm run package   # builds the .vsix
```

Unofficial, not affiliated with Google. Antigravity and Gemini are trademarks of Google LLC.
