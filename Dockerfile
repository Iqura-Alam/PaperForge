# syntax=docker/dockerfile:1
# PaperForge — production image
# Includes TeX Live and official class files from IEEE, ACM, ACL, Springer, ICML, ICLR.
# No local LaTeX installation required on the host.

FROM node:20-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ── TeX stage: install TeX Live + download official template files ────────────
FROM node:20-slim AS texbase

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    wget \
    unzip \
    texlive-latex-base \
    texlive-latex-recommended \
    texlive-latex-extra \
    texlive-publishers \
    texlive-fonts-recommended \
    texlive-fonts-extra \
    texlive-science \
    texlive-bibtex-extra \
    && rm -rf /var/lib/apt/lists/*

# texlive-publishers includes: IEEEtran, acmart
# We additionally download: acl.sty, llncs.cls from their official sources

RUN mkdir -p /templates

# ACL style files — official ACL Organization GitHub repository
RUN wget -q -O /templates/acl.sty \
      https://raw.githubusercontent.com/acl-org/acl-style-files/master/latex/acl.sty \
    && wget -q -O /templates/acl_natbib.bst \
      https://raw.githubusercontent.com/acl-org/acl-style-files/master/latex/acl_natbib.bst \
    || echo "WARN: ACL style download failed; ACL template will compile as plain article"

# Springer LNCS — from CTAN (mirrors.ctan.org is the official CTAN access point)
RUN wget -q -O /tmp/llncs.zip \
      https://mirrors.ctan.org/macros/latex/contrib/llncs.zip \
    && unzip -q -o /tmp/llncs.zip "llncs/llncs.cls" -d /tmp/llncs-unzip/ \
    && mv /tmp/llncs-unzip/llncs/llncs.cls /templates/llncs.cls \
    && rm -rf /tmp/llncs.zip /tmp/llncs-unzip \
    || echo "WARN: LNCS class download failed; Springer template will fall back to article"

# ── Application stage ────────────────────────────────────────────────────────
FROM texbase AS app

WORKDIR /app

# Node modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Application source and static files
COPY . .

# Replace placeholder templates directory with downloaded files
COPY --from=texbase /templates ./templates

# Remove .env — secrets are supplied via environment variables at runtime
RUN rm -f .env

# Jobs dir — ephemeral per container instance
RUN mkdir -p .codex-local/jobs

# Non-root user for security
RUN groupadd -r paperforge \
    && useradd -r -g paperforge -d /app -s /sbin/nologin paperforge \
    && chown -R paperforge:paperforge /app
USER paperforge

EXPOSE 4174
ENV PORT=4174
ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:4174/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.mjs"]
