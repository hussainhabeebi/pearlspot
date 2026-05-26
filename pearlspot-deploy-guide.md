# Pearlspot CRM — Deploy Guide

## Files needed in same folder
```
pearlspot-login.html
pearlspot-dashboard.html
Dockerfile
docker-compose.yml
```

## Option 1 — Coolify (recommended, your existing stack)

1. In Coolify → New Resource → Docker Compose
2. Upload all 4 files OR paste docker-compose.yml
3. Set domain: `pearlspot.aiingo.com`
4. Deploy → Coolify handles SSL automatically

## Option 2 — Manual Docker on Contabo VPS

```bash
# SSH into your VPS
ssh root@156.67.110.188

# Create folder
mkdir -p /opt/pearlspot && cd /opt/pearlspot

# Upload your 4 files here via scp or SFTP
# scp pearlspot-* Dockerfile docker-compose.yml root@156.67.110.188:/opt/pearlspot/

# Build and run
docker compose up -d --build

# Check it's running
docker ps | grep pearlspot
curl http://localhost:3210/health
```

## Option 3 — Direct nginx (no Docker)

```bash
# Copy files to nginx web root
cp pearlspot-login.html /var/www/pearlspot/login.html
cp pearlspot-dashboard.html /var/www/pearlspot/index.html

# Add nginx site config
nano /etc/nginx/sites-available/pearlspot

# Paste:
server {
    listen 80;
    server_name pearlspot.aiingo.com;
    root /var/www/pearlspot;
    index index.html;
    location / { try_files $uri /index.html; }
}

# Enable and reload
ln -s /etc/nginx/sites-available/pearlspot /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# Add SSL via certbot
certbot --nginx -d pearlspot.aiingo.com
```

## Updating the dashboard

```bash
cd /opt/pearlspot

# Replace the HTML files
scp pearlspot-dashboard.html root@156.67.110.188:/opt/pearlspot/pearlspot-dashboard.html

# Rebuild container (takes ~10 seconds)
docker compose up -d --build
```

## Verify deployment

- Login page:    https://pearlspot.aiingo.com/login.html
- Dashboard:     https://pearlspot.aiingo.com/
- Health check:  https://pearlspot.aiingo.com/health
