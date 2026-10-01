# syntax=docker/dockerfile:1

FROM node:20-slim AS base

# Install pdflatex (TeX Live minimal for compilation)
RUN apt-get update && apt-get install -y --no-install-recommends \
    texlive-latex-base \
    texlive-latex-recommended \
    texlive-fonts-recommended \
    texlive-latex-extra \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Source
COPY . .

# Exclude .env from image — use environment variables at runtime
RUN rm -f .env

# Jobs dir inside container — ephemeral per instance
RUN mkdir -p .codex-local/jobs

# Non-root user
RUN groupadd -r paperforge && useradd -r -g paperforge paperforge \
    && chown -R paperforge:paperforge /app
USER paperforge

EXPOSE 4174
ENV PORT=4174
ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:4174/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.mjs"]
