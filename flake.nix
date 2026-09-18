{
  description = "Nord MCP server";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    bun2nix.url = "github:nix-community/bun2nix/2.1.2";
    bun2nix.inputs.nixpkgs.follows = "nixpkgs";
    mcp-servers-nix.url = "github:natsukium/mcp-servers-nix";
    mcp-servers-nix.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    {
      self,
      nixpkgs,
      bun2nix,
      mcp-servers-nix,
    }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      eachSystem = nixpkgs.lib.genAttrs systems;
      pkgsFor =
        system:
        import nixpkgs {
          inherit system;
          overlays = [ bun2nix.overlays.default ];
        };
    in
    {
      lib.mkMcpServer =
        { system, profile }:
        {
          command = nixpkgs.lib.getExe self.packages.${system}.nord-mcp;
          args = [
            "serve"
            "--profile"
            profile
          ];
          enabled = true;
        };

      packages = eachSystem (
        system:
        let
          pkgs = pkgsFor system;
          manifest = builtins.fromJSON (builtins.readFile ./packages/mcp-server/package.json);
        in
        {
          default = self.packages.${system}.nord-mcp;
          inherit (pkgs) bun2nix;
          nord-mcp = pkgs.stdenv.mkDerivation {
            pname = "nord-mcp";
            inherit (manifest) version;
            # The Git flake source already excludes untracked and ignored files.
            src = ./packages/mcp-server;

            nativeBuildInputs = [
              pkgs.bun2nix.hook
              pkgs.nodejs_22
              pkgs.makeWrapper
            ]
            ++ pkgs.lib.optional pkgs.stdenv.hostPlatform.isLinux pkgs.autoPatchelfHook;
            buildInputs = pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [
              pkgs.stdenv.cc.cc.lib
            ];

            bunDeps = pkgs.bun2nix.fetchBunDeps {
              bunNix = ./packages/mcp-server/bun.nix;
            };
            bunInstallFlags = [
              "--frozen-lockfile"
              # Nested dependencies must be writable, not linked into the Nix store.
              "--backend=copyfile"
            ];
            # Dependencies ship prebuilt binaries; no dependency lifecycle scripts are needed.
            dontRunLifecycleScripts = true;

            buildPhase = ''
              runHook preBuild
              export npm_config_cache="$TMPDIR/npm-cache"
              npm run build
              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall
              mkdir -p "$out/lib/nord-mcp" "$out/bin"
              archive=$(npm pack --ignore-scripts --silent)
              tar -xzf "$archive" -C "$out/lib/nord-mcp" --strip-components=1
              cp bun.lock "$out/lib/nord-mcp/"
              pushd "$out/lib/nord-mcp"
              bun install --production --frozen-lockfile --ignore-scripts --backend=copyfile
              popd
              ${pkgs.lib.concatStringsSep "\n" (
                pkgs.lib.mapAttrsToList (name: entry: ''
                  makeWrapper ${pkgs.nodejs_22}/bin/node "$out/bin/${name}" \
                    --add-flags "\"$out/lib/nord-mcp/${entry}\""
                '') manifest.bin
              )}
              runHook postInstall
            '';

            doInstallCheck = true;
            installCheckPhase = ''
              runHook preInstallCheck
              "$out/bin/nord-mcp" --help
              "$out/bin/nord-mcp" --version
              ${pkgs.nodejs_22}/bin/node -e 'require(process.argv[1])' \
                "$out/lib/nord-mcp/node_modules/@napi-rs/keyring"
              runHook postInstallCheck
            '';

            meta = {
              inherit (manifest) description homepage;
              license = pkgs.lib.licenses.asl20;
              mainProgram = "nord-mcp";
              platforms = systems;
            };
          };
        }
      );

      devShells = eachSystem (
        system:
        let
          pkgs = pkgsFor system;
          codexConfig = mcp-servers-nix.lib.mkConfig pkgs {
            flavor = "codex";
            format = "toml";
            fileName = "nord-codex-config.toml";
            settings.servers.nord = {
              command = "${self.packages.${system}.nord-mcp}/bin/nord-mcp";
              args = [
                "serve"
                "--profile"
                "personal"
              ];
              enabled = true;
            };
          };
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.bun
              pkgs.nodejs_22
              pkgs.bun2nix
            ];
          };

          codex = pkgs.mkShell {
            packages = [
              pkgs.codex
              self.packages.${system}.nord-mcp
            ];
            shellHook = ''
              mkdir -p .codex
              if [ ! -e .codex/config.toml ] && [ ! -L .codex/config.toml ]; then
                ln -s ${codexConfig} .codex/config.toml
              elif [ -L .codex/config.toml ] && [[ "$(readlink .codex/config.toml)" == /nix/store/*-nord-codex-config.toml ]]; then
                ln -sfn ${codexConfig} .codex/config.toml
              else
                echo "Preserving existing .codex/config.toml; Nord MCP config is available at ${codexConfig}" >&2
              fi
            '';
          };
        }
      );
    };
}
