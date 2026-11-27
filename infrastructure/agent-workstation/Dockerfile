FROM python:3.12

# Install system dependencies for browser/desktop
RUN apt-get update && apt-get install -y --no-install-recommends \
    xfce4 xfce4-goodies tigervnc-standalone-server novnc websockify dbus x11-xserver-utils \
    libnspr4 libnss3 libatspi2.0-0 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libgcc1 libstdc++6 libpango-1.0-0 libpangocairo-1.0-0 \
    libpangoft2-1.0-0 libgtk-3-0 \
    libasound2 libatspi2.0-0 libcups2 libdrm2 libxcb1 libxshmfence1 \
    libxss1 libxtst6 \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
RUN pip install --no-cache-dir playwright && playwright install chromium

# Set up VNC password (non-interactive: 8-char password "nerdbot")
RUN mkdir -p /home/user/.vnc && printf 'nerdbot\nerdbot' > /home/user/.vnc/passwd && chmod 600 /home/user/.vnc/passwd

# Set up Xfce
RUN mkdir -p /home/user/Desktop && mkdir -p /root/.config/xfce4

# Set up noVNC
RUN mkdir -p /home/user/novnc && ln -sf /usr/share/novnc/vnc.html /home/user/novnc/index.html

# Create user
RUN useradd -m -s /bin/bash user

# Workdir
WORKDIR /home/user

# Expose ports
EXPOSE 5900 6080

# Start VNC and noVNC
ENTRYPOINT ["sh", "-c"]
CMD ["Xvfb :0 -screen 0 1280x800x24 & tigervnc_server :1 -geometry 1280x800 -depth 24 -localhost no -PassFile /home/user/.vnc/passwd & novnc --vnc localhost:5900 --listen 6080 & while true; do sleep 3600; done"]
