{
  description = "Holepunch Challenge Dev Environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        # FHS environment for running prebuilt node native modules
        fhs = pkgs.buildFHSEnv {
          name = "holepunch-dev";
          targetPkgs = pkgs: with pkgs; [
            nodejs_20
            python3
            gnumake
            gcc
            pkg-config
            cmake
            libsodium
            rocksdb
            snappy
            lz4
            zstd
            bzip2
            zlib
            gflags
            libuv
            openssl
            stdenv.cc.cc.lib
          ];
          runScript = "bash";
          profile = ''
            export npm_config_build_from_source=true
            export NODE_OPTIONS="--max-old-space-size=4096"
          '';
        };
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = [ fhs ];
          shellHook = ''
            echo "Run 'holepunch-dev' to enter FHS environment for native modules"
            echo "Then: rm -rf node_modules && npm install"
          '';
        };
      }
    );
}
