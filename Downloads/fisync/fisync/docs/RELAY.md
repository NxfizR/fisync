# Run your own relay

A relay lets phones reach your computer when Tailscale and the local network both fail. It only passes encrypted data, so you can run it on a small server you control. It needs a domain name, a server with a public address, and TLS.

## What the relay sees

- A hash of each computer's ID (a fixed address, not the ID itself)
- The times connections start and end
- The network address of each computer and phone that connects

It cannot see keys, file contents, or what is typed, shown or sent.

## 1. Get a server and a domain

Any small Linux server works. Point a domain name, such as `relay.example.com`, at its public address.

## 2. Install Node.js and fisync's relay

```bash
sudo useradd --system --create-home fisync
sudo -u fisync git clone https://github.com/NxfizR/fisync.git /home/fisync/fisync
cd /home/fisync/fisync
sudo -u fisync npm ci --omit=dev --ignore-scripts
```

## 3. Run it as a service

Create `/etc/systemd/system/fisync-relay.service`:

```ini
[Unit]
Description=fisync relay
After=network-online.target

[Service]
User=fisync
WorkingDirectory=/home/fisync/fisync
Environment=PORT=8787
ExecStart=/usr/bin/node relay/relay.js
Restart=always

[Install]
WantedBy=multi-user.target
```

Then start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now fisync-relay
```

## 4. Add TLS in front

Caddy gets and renews the certificate for you. Install Caddy, then create `/etc/caddy/Caddyfile`:

```
relay.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Reload Caddy with `sudo systemctl reload caddy`. Open ports 80 and 443 on your firewall. Port 8787 should stay closed to the internet.

## 5. Point fisync at it

On the computer, open the phone panel, go to **Remote access**, type `wss://relay.example.com` in the relay field, and click **Save relay**.

Then show a new pairing code under **Pair a phone**. It now carries the relay address. Pair the phone on your home Wi-Fi by scanning that code. From then on, when the phone can't reach the computer directly, it tries the relay.

## Limits and safety

- The relay refuses more than 60 new connections a minute from one address, and never holds more than 8 sessions for one computer.
- Each computer's address can be held by one computer at a time.
- Keep the server updated, and run the relay as its own user, not as root.
- If you stop running the relay, remove its address from fisync's relay field. The phone will simply stop using it.
