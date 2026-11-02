{
  # A wrap-the-release flake: `nix run github:myne-md/myne` runs the published
  # AppImage under an FHS shim. (The from-source Tauri-on-Nix build — webkitgtk
  # + wrapGAppsHook + pnpm + sidecars — is a follow-up; this exists so Nix/NixOS
  # users can run it without appimage-run gymnastics.)
  #
  # The URLs point at downloads.myne.md, not at GitHub, and that is not a
  # preference. Every myne-md repository is private, so a release-asset URL on
  # github.com answers 404 to everyone who is not a member, and `fetchurl`
  # carries no credential. These URLs were pinned to v0.4.0 GitHub assets, so
  # `nix run` had never once worked for an outside user and nothing said so.
  # `decisions.md` 2026-08-15 (entry 0496).
  #
  # Fetching from the project's own origin does not cross the 2026-08-09 line
  # against Myne-initiated downloads: Nix is not a Myne client, an AppImage is
  # not a model, and the fetch happens because the user ran `nix run`.
  #
  # Updated to v0.11.4 on 2026-11-02; both arches ship an AppImage again, so both
  # arms move together.
  description = "Myne — calm, end-to-end-encrypted markdown notes";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAll = nixpkgs.lib.genAttrs systems;
      srcFor = system: pkgs:
        {
          "x86_64-linux" = pkgs.fetchurl {
            url = "https://downloads.myne.md/releases/v0.11.4/Myne_0.11.4_amd64.AppImage";
            sha256 = "sha256-cKzZ5BFSFJft5I4rWv8pYI0eLG4q51R6cpmFFnev8Dg=";
          };
          "aarch64-linux" = pkgs.fetchurl {
            url = "https://downloads.myne.md/releases/v0.11.4/Myne_0.11.4_aarch64.AppImage";
            sha256 = "sha256-37bd0jl1j/GskNcxODohdWGuFX4t7K0NjLwcC4QmORw=";
          };
        }.${system};
    in {
      packages = forAll (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          myne = pkgs.appimageTools.wrapType2 {
            pname = "myne";
            version = "0.11.4";
            src = srcFor system pkgs;
          };
        in { default = myne; myne = myne; });

      apps = forAll (system: {
        default = { type = "app"; program = "${self.packages.${system}.default}/bin/myne"; };
        myne = { type = "app"; program = "${self.packages.${system}.default}/bin/myne"; };
      });
    };
}
