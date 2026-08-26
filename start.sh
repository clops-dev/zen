#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Zen Gateway — One-Click VM Setup & Start Script
# -----------------------------------------------------------------------------
set -e

# Visual colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${CYAN}=====================================================${NC}"
echo -e "${CYAN}         🚀 Zen Gateway Setup & Deployer            ${NC}"
echo -e "${CYAN}=====================================================${NC}"

# 1. Check & Install Docker
if ! command -v docker &> /dev/null; then
    echo -e "${YELLOW}[1/4] Docker not found. Installing Docker...${NC}"
    sudo apt-get update -y
    sudo apt-get install -y curl git
    curl -fsSL https://get.docker.com | sh
    sudo usermod -aG docker "$USER" || true
    echo -e "${GREEN}✓ Docker installed successfully.${NC}"
else
    echo -e "${GREEN}✓ [1/4] Docker is already installed.${NC}"
fi

# 2. Setup Environment Variables (.env & .env.production)
echo -e "${YELLOW}[2/4] Checking environment configuration...${NC}"

if [ ! -f .env ] && [ ! -f .env.production ]; then
    echo -e "${YELLOW}No .env file found. Generating default configuration...${NC}"
    
    # Generate 64-char SESSION_SECRET
    SESSION_SECRET=$(openssl rand -hex 32 2>/dev/null || node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" 2>/dev/null || head -c 32 /dev/urandom | xxd -p | tr -d '\n')
    
    cat << EOF > .env.production
# Database connection (Replace with your Neon or PostgreSQL URL)
DATABASE_URL=postgresql://zen:zen@postgres:5432/zen

# Server port
PORT=8787

# Authentication Secrets
SESSION_SECRET=${SESSION_SECRET}

# bcrypt cost factor
BCRYPT_COST=12

# Bootstrap admin (Created automatically on first boot)
ADMIN_EMAIL=admin@zen.com
ADMIN_PASSWORD=admin123456

# Default monthly token budget
DEFAULT_FREE_TOKEN_BUDGET=50000
EOF
    cp .env.production .env
    echo -e "${GREEN}✓ Created default .env.production and .env files.${NC}"
    echo -e "${YELLOW}  (If using Neon, update DATABASE_URL in .env.production)${NC}"
else
    # Sync existing .env / .env.production and strip problematic PgBouncer parameters
    if [ -f .env ] && [ ! -f .env.production ]; then
        cp .env .env.production
    elif [ -f .env.production ] && [ ! -f .env ]; then
        cp .env.production .env
    fi

    # Strip &channel_binding=require if present (causes Neon PgBouncer connection timeouts)
    sed -i 's/&channel_binding=require//g' .env 2>/dev/null || true
    sed -i 's/&channel_binding=require//g' .env.production 2>/dev/null || true

    echo -e "${GREEN}✓ Environment files synced and validated.${NC}"
fi

chmod 600 .env .env.production 2>/dev/null || true

# 3. Build and Start Gateway with Docker Compose
echo -e "${YELLOW}[3/4] Building and launching Zen Gateway container...${NC}"

# Detect if using local DB or remote DB
if grep -q "postgres:5432" .env.production; then
    echo -e "${CYAN}Starting Gateway + Local Postgres container stack...${NC}"
    docker compose up -d --build
else
    echo -e "${CYAN}Starting Gateway connected to remote PostgreSQL / Neon...${NC}"
    docker compose up -d --build gateway
fi

# 4. Health & Readiness Probe Check
echo -e "${YELLOW}[4/4] Waiting for Zen Gateway to report READY...${NC}"

MAX_RETRIES=15
RETRY=0
READY=false

while [ $RETRY -lt $MAX_RETRIES ]; do
    HTTP_CODE=$(curl -s -o /tmp/readyz.json -w "%{http_code}" http://127.0.0.1:8787/readyz 2>/dev/null || echo "000")
    if [ "$HTTP_CODE" = "200" ]; then
        READY=true
        break
    fi
    echo -n "."
    sleep 2
    RETRY=$((RETRY+1))
done
echo ""

if [ "$READY" = "true" ]; then
    echo -e "${GREEN}=====================================================${NC}"
    echo -e "${GREEN}   🎉 Zen Gateway is UP and READY!                 ${NC}"
    echo -e "${GREEN}=====================================================${NC}"
    echo -e "  • Admin Dashboard: ${CYAN}http://<YOUR_VM_IP>:8787/admin2${NC}"
    echo -e "  • OpenAI Endpoint: ${CYAN}http://<YOUR_VM_IP>:8787/v1/chat/completions${NC}"
    echo -e "  • Health Endpoint: ${CYAN}http://<YOUR_VM_IP>:8787/readyz${NC}"
    echo -e ""
    echo -e "  Useful Management Commands:"
    echo -e "    View Logs : ${CYAN}docker compose logs -f gateway${NC}"
    echo -e "    Restart   : ${CYAN}docker compose restart gateway${NC}"
    echo -e "    Stop      : ${CYAN}docker compose down${NC}"
    echo -e "${GREEN}=====================================================${NC}"
else
    echo -e "${RED}⚠️ Gateway started but DB probe timed out or is initializing.${NC}"
    echo -e "${YELLOW}Check container logs using: ${CYAN}docker compose logs -f gateway${NC}"
fi
