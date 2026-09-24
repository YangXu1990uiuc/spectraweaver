# Security

workstreams puts a shell in a web page: **anyone who can sign in gets a shell on your server, as you.** Treat access to it the way you treat SSH access.

## Deploying it safely

- **Keep the default.** It listens on 127.0.0.1 only, so nothing on the network can reach it directly.
- **Reach it through an SSH tunnel or a VPN.** An SSH tunnel is the simplest: `ssh -L 7777:localhost:7777 your-server`, then open `http://localhost:7777`. A VPN also works: your company's, Tailscale or WireGuard. Browsers treat `localhost` as a secure context, so clipboard features work over a tunnel.
- **Never expose it to the public internet.**
  - Don't forward its port on a router or cloud firewall.
  - Don't bind it to a public interface.
  - Don't publish it through a reverse proxy without an additional authentication layer in front.
- **Beyond localhost, it speaks plain HTTP.** Binding another address (`--host`) requires `--allow-remote`, because passwords, tokens and terminal contents would then cross the network unencrypted. If you must, put it behind HTTPS on a trusted network: Tailscale Serve, or a reverse proxy with TLS and its own authentication. Pass `--allow-host <name>` for the name browsers use.
- **Use a strong password.** Sign-in is required even on localhost, because other users on the same machine can reach 127.0.0.1. Password guessing is throttled, but a strong password is still your main protection. If a login link or token may have leaked, run `workstreams token --rotate`: it invalidates the token and every browser login.

## What it protects against

Summarised from [DESIGN.md §9](DESIGN.md#9-security):

- **Other users on the same machine.**
  - Sign-in is mandatory.
  - Files and sockets are owner-only (0700 / 0600).
  - Password guessing is throttled.
- **Malicious websites open in your browser.**
  - Origin and Host checks guard against CSRF, cross-site WebSocket hijacking and DNS rebinding.
  - Cookies are `HttpOnly` and `SameSite=Strict`.
  - The page refuses to run inside another site's frame.
- **Hostile terminal output.**
  - Output is rendered as text, never as HTML.
  - Only `http` and `https` links open.
  - Programs may write to your clipboard but never read it.
  - Pasted text is stripped of control sequences.

It does **not** protect against:
- someone who has your password, a valid token or a signed-in browser;
- root, or anyone else who can read your files, on the server;
- a compromised computer or browser on your side.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: the repository's **Security** tab → **Report a vulnerability**. Don't open a public issue. Include the version (`workstreams version`), what an attacker needs, and the steps to reproduce. You will get an acknowledgement within a week.
