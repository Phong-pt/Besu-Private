# Public, pinned runtimes. No host binaries, credentials or chain state are build inputs.
FROM node@sha256:c0a93797ee78814ae6d32fcca2561fdbbe423149c3f5389aad32d86e9fd85bd4 AS node
FROM eclipse-temurin@sha256:e0e760919dc8ee2edb89046665da66373a2cefcfdcd26e4b88f4e0b23ff04275 AS java
FROM java AS runtimes
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN curl -fL --retry 3 -o /tmp/besu.tar.gz https://github.com/hyperledger/besu/releases/download/26.10.2/besu-26.10.2.tar.gz \
    && echo '8cc633e19cb23cd38b5d6ad988b725c8533389a773aea65782fd16d37946825b  /tmp/besu.tar.gz' | sha256sum -c - \
    && mkdir /opt/besu && tar -xzf /tmp/besu.tar.gz -C /opt/besu --strip-components=1 && rm /tmp/besu.tar.gz
RUN curl -fL --retry 3 -o /tmp/dora.tar.gz https://github.com/ethpandaops/dora/releases/download/v1.25.0/dora_1.25.0_linux_amd64.tar.gz \
    && echo '67f708f04732775a1642ca392bdfce28b954ce094e20a1c7605a08ae620f6af7  /tmp/dora.tar.gz' | sha256sum -c - \
    && mkdir /opt/dora-dist && tar -xzf /tmp/dora.tar.gz -C /opt/dora-dist && rm /tmp/dora.tar.gz
WORKDIR /src/teku
RUN git init && git remote add origin https://github.com/Consensys/teku.git \
    && git fetch --depth 256 origin 715545a182748b959540bfceee12286e058ca49d tag 26.10.1 \
    && git checkout --detach 715545a182748b959540bfceee12286e058ca49d && git config core.abbrev 10 \
    && test "$(git rev-parse HEAD)" = 715545a182748b959540bfceee12286e058ca49d
RUN ./gradlew installDist -x test --no-daemon --max-workers=2

FROM ghcr.io/blockscout/blockscout@sha256:7659f168e4e2f6b73dd559ae5278fe96ba67bc2905ea01b57a814c68adf5a9dc AS explorer
FROM ghcr.io/blockscout/frontend@sha256:4b69f44148414b55c6b8550bc3270c63c9f99e923d54ef0b307e762af6bac90a AS frontend
FROM ghcr.io/blockscout/smart-contract-verifier@sha256:a7580f42b55c0aafad43a2acd979b60adddc1e9985a8cf01857179962f0fe063 AS verifier
FROM postgres@sha256:3b0cda93be7c8dba2ed484d19393d93845dc3dafb88973e248ba8e6d99d784e1
RUN apt-get update && apt-get install -y --no-install-recommends python3 nginx ca-certificates curl bash util-linux libstdc++6 libssl3t64 libncurses6 libatomic1 && rm -rf /var/lib/apt/lists/*
# The explorer release uses musl; keep its runtime libraries separate from glibc.
COPY --from=explorer /lib/ld-musl-x86_64.so.1 /lib/ld-musl-x86_64.so.1
COPY --from=explorer /lib/ /opt/explorer-libs/base/
COPY --from=explorer /usr/lib/ /opt/explorer-libs/usr/
COPY --from=explorer /app/ /app/
COPY --from=frontend /app/ /opt/explorer-frontend/
COPY --from=frontend /usr/local/bin/node /opt/frontend-bin/node
COPY --from=frontend /lib/ /opt/frontend-libs/base/
COPY --from=frontend /usr/lib/ /opt/frontend-libs/usr/
COPY --from=verifier /app/smart-contract-verifier-server /opt/verifier/server
COPY --from=java /opt/java/openjdk/ /opt/java/
COPY --from=runtimes /opt/besu/ /opt/besu/
COPY --from=runtimes /src/teku/build/install/teku/ /opt/teku/
COPY --from=runtimes /src/teku/ethereum/spec/src/main/resources/tech/pegasys/teku/spec/config/configs/minimal.yaml /opt/teku-source/ethereum/spec/src/main/resources/tech/pegasys/teku/spec/config/configs/minimal.yaml
COPY --from=runtimes /src/teku/acceptance-tests/src/testFixtures/resources/besu/osakaGenesis.json /src/teku/acceptance-tests/src/testFixtures/resources/besu/pragueGenesis.json /opt/teku-source/acceptance-tests/src/testFixtures/resources/besu/
COPY --from=node /usr/local/bin/node /opt/node/bin/node
COPY --from=node /usr/local/lib/node_modules/npm/ /opt/node/lib/node_modules/npm/
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /opt/node/bin/npm
COPY --from=runtimes /opt/dora-dist/dora-explorer /opt/dora
ENV PATH="/opt/node/bin:${PATH}" JAVA_HOME=/opt/java BESU_POS_JAVA_HOME=/opt/java BESU_POS_HOME=/opt/besu TEKU_POS_HOME=/opt/teku TEKU_SOURCE_HOME=/opt/teku-source BESU_STATE_DIR=/data/network BESU_ALLOW_RUNTIME_RELOCATION=1 NODE_MODULES_DIR=/opt/dependencies/node_modules DATABASE_LOCAL=1 PGHOST=/var/run/postgresql
COPY container/package*.json /opt/dependencies/
RUN cd /opt/dependencies && npm ci --omit=dev --ignore-scripts && npm cache clean --force
WORKDIR /opt/credentials
COPY backend/*.cjs ./backend/
COPY web/ ./web/
COPY contracts/src/ ./contracts/src/
COPY database/schema.sql database/index.sql ./database/
COPY network/pos/manage.py network/pos/besu.toml network/pos/dora.yaml network/pos/validator-names.yaml network/pos/deploy-contracts.cjs network/pos/verify-contracts.cjs ./network/pos/
COPY network/pos/blockscout/loopback.exs ./network/pos/blockscout/
COPY container/entrypoint.py container/health.py container/nginx.conf /opt/container/
RUN test ! -e network/pos/.local && ln -s /data/network network/pos/.local && cat network/pos/blockscout/loopback.exs >> /app/releases/9.0.2/runtime.exs
VOLUME ["/data"]
EXPOSE 13002 13000 18080 18081
HEALTHCHECK --interval=30s --timeout=20s --start-period=1800s --retries=5 CMD ["python3", "/opt/container/health.py"]
ENTRYPOINT ["python3", "-u", "/opt/container/entrypoint.py"]
