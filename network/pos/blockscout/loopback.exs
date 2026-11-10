
# BESU_LOCAL_LOOPBACK: evaluated after the image's own runtime configuration.
# BLOCKSCOUT_HOST only controls generated URLs, not the listen address.
config :block_scout_web, BlockScoutWeb.Endpoint, http: [ip: {127, 0, 0, 1}]
config :block_scout_web, BlockScoutWeb.HealthEndpoint, http: [ip: {127, 0, 0, 1}]
