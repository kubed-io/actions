# Build and Push Image Action  

Sets up buildx and bakes the docker compose file. 

`fresh` names PyPI packages, space-separated. Their newest releases go into the bake as
`DEPS_FRESH` (`name==version ...`). A Dockerfile that declares `ARG DEPS_FRESH` just before its
dependency install reinstalls that layer when one of them releases, and reuses its cache
otherwise. Forward it through the compose file's `build.args` (`DEPS_FRESH: ${DEPS_FRESH:-}`).
