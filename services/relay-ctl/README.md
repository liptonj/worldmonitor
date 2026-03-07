# relay-ctl

CLI for managing relay services via Supabase.

## Setup

Set environment variables:

```bash
export SUPABASE_URL=https://your-project.supabase.co
export SUPABASE_SERVICE_KEY=your-service-role-key
```

Or use a `.env` file in the services directory (loaded by your shell or tooling).

## Usage

```bash
# List all services and their status
relay-ctl list

# Manually trigger a service (polls until completion)
relay-ctl trigger markets

# Enable or disable a service
relay-ctl enable markets
relay-ctl disable markets

# Show detailed status of a single service
relay-ctl status markets
```

## Running

From the `services/relay-ctl` directory:

```bash
node index.cjs list
```

Or after `npm link` / global install:

```bash
relay-ctl list
```
