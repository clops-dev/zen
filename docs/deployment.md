# Zen Gateway — Multi-Instance Deployment & Operations Guide

This guide details setting up, operating, testing, and rolling out **Zen Gateway** across multiple independent virtual machines behind HAProxy.

---

## 1. Multi-VM Architecture

```text
                                  INTERNET
                                     │
                                     ▼
                      LOAD BALANCER (Single HAProxy VM)
                      - TLS Termination
                      - Unbuffered HTTP/1.1 SSE Streaming
                      - Probes /readyz every 3s
                                │         │
                    ┌───────────┘         └───────────┐
                    ▼                                 ▼
             Gateway VM 1                      Gateway VM 2
      ┌────────────────────────┐        ┌────────────────────────┐
      │  Docker Compose Stack  │        │  Docker Compose Stack  │
      │  └── zen-gateway       │        │  └── zen-gateway       │
      └────────────────────────┘        └────────────────────────┘
                    │                                 │
                    └────────────────┬────────────────┘
                                     │
                                     ▼
                             Neon PostgreSQL
                         (Cloud-Managed Database)
```

### Server Roles

1. **HAProxy Load Balancer VM**:
   - Runs HAProxy 2.8+ using `haproxy.cfg`.
   - Listens on public HTTP (80) / HTTPS (443).
   - Probes `Gateway VM1:8787/readyz` and `Gateway VM2:8787/readyz`.

2. **Gateway VM 1 (`10.0.0.10`)**:
   - Independent Linux VM running Docker Engine & Compose.
   - Container running `zen-gateway:<git-sha>`.
   - Connected to Neon PostgreSQL via `DATABASE_URL` in `.env.production`.

3. **Gateway VM 2 (`10.0.0.11`)**:
   - Independent Linux VM running Docker Engine & Compose.
   - Container running `zen-gateway:<git-sha>`.
   - Connected to Neon PostgreSQL via `DATABASE_URL` in `.env.production`.

---

## 2. Step-by-Step Deployment Instructions

### Step 1: Provision Managed Database (Neon)
1. Provision a Neon PostgreSQL database project.
2. Obtain the pooled connection string: `postgresql://user:pass@ep-xxx-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require`.

### Step 2: Configure Gateway VM 1 & VM 2
On each Gateway VM:
1. Clone repository / download production Docker Compose stack:
   ```bash
   mkdir -p /opt/zen-gateway && cd /opt/zen-gateway
   ```
2. Create `.env.production` (gitignored, permissions `600`):
   ```ini
   DATABASE_URL=postgresql://user:pass@ep-xxx-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require
   SESSION_SECRET=64_char_hex_secret_here
   ADMIN_EMAIL=admin@yourdomain.com
   ADMIN_PASSWORD=change_me_on_first_login
   PORT=8787
   NODE_ENV=production
   SHUTDOWN_DRAIN_MS=25000
   ```
3. Start the gateway instance:
   ```bash
   docker compose -f docker-compose.yml up -d gateway
   ```

### Step 3: Configure HAProxy Load Balancer
On the HAProxy VM:
1. Copy `haproxy.cfg` to `/etc/haproxy/haproxy.cfg`.
2. Update backend IP addresses:
   ```haproxy
   server gateway1 10.0.0.10:8787 check
   server gateway2 10.0.0.11:8787 check
   ```
3. Start or reload HAProxy:
   ```bash
   systemctl reload haproxy
   ```

---

## 3. Verification & Operational Testing (Validation Criteria A–M)

### A. Migration Advisory Lock Test (Simultaneous Boot)
- **Action**: Stop both gateway instances, clear DB schema, then execute `docker compose up -d gateway` on `VM1` and `VM2` at the exact same second.
- **Expected Outcome**: Transactional lock `pg_advisory_xact_lock(74839281)` serializes migration execution. Exactly one node applies migrations while the other waits safely. No `relation already exists` errors occur.

### B. Health-Based Routing Test (`/readyz`)
- **Action**: Query HAProxy status and `/readyz` endpoint.
- **Expected Outcome**: `curl http://10.0.0.10:8787/readyz` returns `{"ready": true, "db": "ok"}` with HTTP 200. HAProxy marks backend `gateway1` UP.

### C. Graceful Drain Test (SIGTERM Signal Flow)
- **Action**: Run `docker stop zen-gateway` on `VM1`.
- **Signal Flow**:
  1. SIGTERM received by Bun process.
  2. `setReady(false, 'draining_for_SIGTERM')` invoked.
  3. `VM1:8787/readyz` returns HTTP 503 (`{"ready": false, "reason": "draining_for_SIGTERM"}`).
  4. HAProxy health check fails after 6s (`fall 2`), marking `gateway1` DOWN for new incoming requests.
  5. HAProxy routes all new requests to `gateway2` (`VM2`).
  6. Existing connections on `VM1` complete within `SHUTDOWN_DRAIN_MS` (25s).
  7. Server stops cleanly and exits 0.

### D. Active SSE Stream Protection Test
- **Action**: Initiate a long-running streaming prompt via `curl -N http://haproxy/v1/chat/completions ...`. Mid-stream, issue `docker stop` on the VM servicing the stream.
- **Expected Outcome**: The active stream continues outputting tokens cleanly without truncation until finished. New requests concurrently land on the remaining active node.

### E. Rolling Deployment Procedure
1. Pull new container version on `VM1`:
   ```bash
   docker compose pull gateway
   ```
2. Restart `VM1`:
   ```bash
   docker stop zen-gateway && docker compose up -d gateway
   ```
3. Verify `VM1` passes readiness (`curl http://10.0.0.10:8787/readyz`).
4. Repeat steps 1–3 for `VM2`.
- **Expected Outcome**: Zero downtime; user-facing traffic experiences no dropped calls.

### F. Rollback Procedure
If a newly deployed tag (`zen-gateway:v2`) exhibits issues:
1. Update `docker-compose.prod.yml` image tag on `VM1` to previous SHA:
   ```yaml
   services:
     gateway:
       image: zen-gateway:previous-sha
   ```
2. Restart `VM1`:
   ```bash
   docker compose up -d gateway
   ```
3. Verify `VM1` readiness, then repeat for `VM2`.
