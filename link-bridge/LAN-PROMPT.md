# Prompt: join another computer's AI Link over Wi-Fi

Paste the prompt below into Claude Code on the **second** computer (same Wi-Fi as the first). Replace `<KEY>` with the key the first computer printed for `node lan.mjs key` (it is in `~/.session-link/lan.key` there). Never commit or post the key: anyone with it on your network can type into your sessions.

On the first computer, `lan.mjs` must already be running (`cd link-bridge && node lan.mjs`).

---

```
Set up AI Link on this computer so my Claude Code sessions here can talk to the ones on my other computer on the same Wi-Fi. Do each step, check it worked, and stop and tell me if one fails.

1. Check Node 18 or newer is installed (`node -v`). If not, tell me how to install it and stop.
2. Clone https://github.com/Creeperprol/ai-link to ~/ai-link (if it is already there, `git pull` instead).
3. Register the link MCP server for Claude Code at user scope:
   claude mcp add link --scope user -e LINK_CLI=claude -- node ~/ai-link/link-bridge/server.mjs
   (If a server named "link" already exists, show me its command and ask before replacing it.)
4. Save the shared key: cd ~/ai-link/link-bridge && node lan.mjs join <KEY>
5. Make sessions here read link messages by themselves (needed on Windows, where nothing can type into the window): run cd ~/ai-link/link-bridge && node listen.mjs install. Show me what it printed.
6. Start the LAN link so it keeps running after this session: open a new Terminal window that runs
   cd ~/ai-link/link-bridge && node lan.mjs
   (on macOS: osascript -e 'tell application "Terminal" to do script "cd ~/ai-link/link-bridge && node lan.mjs"').
   It should print "link lan: <machine> on UDP 47811 / HTTP 47812".
7. Wait about 5 seconds, then list ~/.session-link/peers/*.json and tell me whether any entry has "remote": true (a session on the other computer). If none does, the Wi-Fi may block broadcast: ask me for the other computer's IP address (`ipconfig getifaddr en0` there), stop the lan.mjs window, and start it again as
   LINK_LAN_PEERS=<that IP> node lan.mjs
8. Tell me to open a new Claude Code session (with listen.mjs installed any terminal works, Windows Terminal too; this session started before the MCP server was added, so it does not have the link tools). In that new session, link_peers lists the other computer's sessions as "... on <machine>".

Finish with one short summary: what is installed, whether the other computer's sessions are visible, and anything left for me to do.
```
