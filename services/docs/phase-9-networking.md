# Phase 9: Networking & Secrets

## Cloudflare Tunnel

The relay gateway can be exposed to the internet via a Cloudflare Tunnel, avoiding the need to open ports on the host.

### 1. Create a Cloudflare Tunnel

1. Log in to [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/).
2. Go to **Networks** → **Tunnels**.
3. Click **Create a tunnel**.
4. Choose **Cloudflared**.
5. Name the tunnel (e.g. `relay-gateway`).
6. Under **Public Hostname**, add a hostname (e.g. `relay.yourdomain.com`) and set the **Service** to `http://gateway:3004` (Docker internal hostname).
7. Complete the setup and copy the **Tunnel token**.

### 2. Set TUNNEL_TOKEN

Add the tunnel token to your environment:

```bash
export TUNNEL_TOKEN=your-cloudflare-tunnel-token
```

Or add it to your `.env` file (do not commit `.env`).

### 3. Run with Tunnel

Start the stack with the tunnel profile:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile tunnel up -d
```

The `cloudflared` service only starts when the `tunnel` profile is active. If `TUNNEL_TOKEN` is not set, the tunnel container will fail to connect; ensure it is set before using the profile.

### 4. Verify No Ports Exposed

With the tunnel in place, the gateway is reachable only via the Cloudflare hostname. No host ports need to be published:

- The gateway listens on port 3004 **inside** the Docker network.
- Cloudflared connects to `gateway:3004` and proxies traffic from the public hostname.
- No `ports:` mapping is required on the gateway or cloudflared.

Check that no relay ports are bound on the host:

```bash
# Should show no relay-related ports (3004, 50051, etc.) listening on 0.0.0.0
ss -tlnp | grep -E '3004|50051|50052|50053'
```

## Secrets

See `services/.env.example` for all required and optional environment variables. Never commit `.env` or real credentials.
