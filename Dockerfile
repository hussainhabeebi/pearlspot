FROM nginx:alpine

# Remove default nginx static files
RUN rm -rf /usr/share/nginx/html/*

# Copy dashboard files
COPY pearlspot-login.html /usr/share/nginx/html/login.html
COPY pearlspot-dashboard.html /usr/share/nginx/html/index.html

# Custom nginx config — SPA-friendly, no cache on HTML
RUN cat > /etc/nginx/conf.d/default.conf << 'EOF'
server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    # Disable cache for HTML files
    location ~* \.html$ {
        add_header Cache-Control "no-cache, no-store, must-revalidate";
        add_header Pragma "no-cache";
        add_header Expires "0";
        add_header Access-Control-Allow-Origin "*";
    }

    # Serve static assets with long cache
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    # Fallback to index.html for any unknown route
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Health check endpoint
    location /health {
        return 200 "ok";
        add_header Content-Type text/plain;
    }

    # Gzip
    gzip on;
    gzip_types text/plain text/css application/javascript text/html;
    gzip_min_length 1024;
}
EOF

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
