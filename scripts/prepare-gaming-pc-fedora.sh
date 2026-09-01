#!/usr/bin/env bash
# One-time bootstrap for a Fedora-based desktop (Fedora Workstation, Nobara)
# to reach a game-ready state: Steam, Lutris, Heroic, ProtonUp-Qt, headless
# GE-Proton installs, core Wine/Vulkan dependencies, and a best-effort
# Battle.net install via Lutris.
#
# Functionally equivalent to prepare-gaming-pc-debian.sh, adapted for dnf/RPM
# Fusion instead of apt. Nobara ships most of this out of the box (Steam,
# Lutris, Wine, GPU drivers, Proton-GE) via its own Welcome app, so most
# steps below will just report "already installed" there - that's expected.
#
# Safe to re-run - each step checks whether its target is already installed
# before doing anything.

set -uo pipefail

LOGFILE="$HOME/prepare-gaming-pc.log"
: > "$LOGFILE"

STEP=0
COMPLETED=()
COMPLETED_NUM=()
FAILED=()
FAILED_NUM=()
FAILED_RESOLUTIONS=()
MANUAL=()

ok() {
    STEP=$((STEP + 1))
    COMPLETED+=("$1")
    COMPLETED_NUM+=("$STEP")
    printf '%2d. [OK]     %s\n' "$STEP" "$1"
}

fail() {
    STEP=$((STEP + 1))
    FAILED+=("$1")
    FAILED_NUM+=("$STEP")
    FAILED_RESOLUTIONS+=("$2")
    printf '%2d. [FAILED] %s\n' "$STEP" "$1"
}

manual() {
    MANUAL+=("$1")
}

if [ "$(id -u)" -eq 0 ]; then
    SUDO=""
else
    SUDO="sudo"
fi

HAS_DISPLAY=false
if [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; then
    HAS_DISPLAY=true
fi

GPU_VENDOR=""

precheck_distro() {
    if [ -f /etc/fedora-release ]; then
        return
    fi
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        if [ "${ID:-}" = "fedora" ] || [ "${ID:-}" = "nobara" ] || [[ "${ID_LIKE:-}" == *fedora* ]]; then
            return
        fi
    fi
    echo "This script targets Fedora-based distributions (Fedora Workstation, Nobara). Aborting." >&2
    exit 1
}

detect_gpu_vendor() {
    local gpu
    gpu=$(lspci 2>/dev/null | grep -Ei 'vga|3d controller' || true)
    if echo "$gpu" | grep -qi nvidia; then
        GPU_VENDOR="nvidia"
    elif echo "$gpu" | grep -qi amd; then
        GPU_VENDOR="amd"
    elif echo "$gpu" | grep -qi intel; then
        GPU_VENDOR="intel"
    fi
}

# ---------------------------------------------------------------------------
# Core OS-level dependencies
# ---------------------------------------------------------------------------

install_core_deps() {
    local pkgs=(wine winetricks cabextract p7zip p7zip-plugins unzip curl wget
        gnupg2 ca-certificates flatpak mesa-vulkan-drivers mesa-vulkan-drivers.i686
        vulkan-loader vulkan-loader.i686 vulkan-tools gamemode pipx)

    if $SUDO dnf install -y "${pkgs[@]}" >>"$LOGFILE" 2>&1; then
        ok "Install core dependencies (wine, winetricks, Vulkan drivers incl. 32-bit, gamemode, pipx, flatpak, etc.)"
        return
    fi

    echo "Batch install failed, retrying packages individually to isolate failures" >>"$LOGFILE"
    local bad=()
    for p in "${pkgs[@]}"; do
        if ! $SUDO dnf install -y "$p" >>"$LOGFILE" 2>&1; then
            bad+=("$p")
        fi
    done

    if [ ${#bad[@]} -eq 0 ]; then
        ok "Install core dependencies (wine, winetricks, Vulkan drivers incl. 32-bit, gamemode, pipx, flatpak, etc.)"
    else
        fail "Install core dependencies" "The following packages failed to install: ${bad[*]}. Run 'dnf search <name>' to find the correct package name for your Fedora release, then install manually with dnf."
    fi
}

ensure_flatpak() {
    if ! command -v flatpak >/dev/null 2>&1; then
        $SUDO dnf install -y flatpak >>"$LOGFILE" 2>&1 || return 1
    fi
    $SUDO flatpak remote-add --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo >>"$LOGFILE" 2>&1
}

enable_rpmfusion() {
    local fedora_ver
    fedora_ver=$(rpm -E %fedora)
    if $SUDO dnf install -y \
        "https://mirrors.rpmfusion.org/free/fedora/rpmfusion-free-release-${fedora_ver}.noarch.rpm" \
        "https://mirrors.rpmfusion.org/nonfree/fedora/rpmfusion-nonfree-release-${fedora_ver}.noarch.rpm" \
        >>"$LOGFILE" 2>&1; then
        ok "Enable RPM Fusion (free + nonfree - needed for Steam and NVIDIA drivers)"
        return 0
    fi
    fail "Enable RPM Fusion (free + nonfree)" "Run: sudo dnf install https://mirrors.rpmfusion.org/free/fedora/rpmfusion-free-release-\$(rpm -E %fedora).noarch.rpm https://mirrors.rpmfusion.org/nonfree/fedora/rpmfusion-nonfree-release-\$(rpm -E %fedora).noarch.rpm"
    return 1
}

# ---------------------------------------------------------------------------
# Launchers
# ---------------------------------------------------------------------------

install_steam() {
    if command -v steam >/dev/null 2>&1 || rpm -q steam >/dev/null 2>&1; then
        ok "Steam (already installed)"
        return
    fi

    if $SUDO dnf install -y steam >>"$LOGFILE" 2>&1; then
        ok "Install Steam (dnf, via RPM Fusion)"
        return
    fi

    echo "dnf install steam failed, falling back to Flatpak" >>"$LOGFILE"
    if ensure_flatpak && $SUDO flatpak install -y flathub com.valvesoftware.Steam >>"$LOGFILE" 2>&1; then
        ok "Install Steam (Flatpak fallback)"
    else
        fail "Install Steam" "Make sure RPM Fusion is enabled (see above), then run 'sudo dnf install steam', or run 'flatpak install flathub com.valvesoftware.Steam'."
    fi
}

install_lutris() {
    if command -v lutris >/dev/null 2>&1; then
        ok "Lutris (already installed)"
        return
    fi

    if $SUDO dnf install -y lutris >>"$LOGFILE" 2>&1; then
        ok "Install Lutris (dnf package)"
        return
    fi

    if ensure_flatpak && $SUDO flatpak install -y flathub net.lutris.Lutris >>"$LOGFILE" 2>&1; then
        ok "Install Lutris (Flatpak)"
    else
        fail "Install Lutris" "Run: flatpak install flathub net.lutris.Lutris (or see https://lutris.net/downloads/ for a distro package)."
    fi
}

install_heroic() {
    if flatpak list 2>/dev/null | grep -q com.heroicgameslauncher.hgl; then
        ok "Heroic Games Launcher (already installed)"
        return
    fi

    if ensure_flatpak && $SUDO flatpak install -y flathub com.heroicgameslauncher.hgl >>"$LOGFILE" 2>&1; then
        ok "Install Heroic Games Launcher (Flatpak - covers Epic Games Store and can sideload Ubisoft Connect)"
    else
        fail "Install Heroic Games Launcher" "Run: flatpak install flathub com.heroicgameslauncher.hgl"
    fi
}

install_protonup_qt() {
    if flatpak list 2>/dev/null | grep -q net.davidotek.pupgui2; then
        ok "ProtonUp-Qt (already installed)"
        return
    fi

    if ensure_flatpak && $SUDO flatpak install -y flathub net.davidotek.pupgui2 >>"$LOGFILE" 2>&1; then
        ok "Install ProtonUp-Qt (GUI fallback for managing GE-Proton/Wine-GE builds)"
    else
        fail "Install ProtonUp-Qt" "Run: flatpak install flathub net.davidotek.pupgui2"
    fi
}

install_protonplus() {
    if flatpak list 2>/dev/null | grep -q com.vysp3r.ProtonPlus; then
        ok "ProtonPlus (already installed)"
        return
    fi

    if ensure_flatpak && $SUDO flatpak install -y flathub com.vysp3r.ProtonPlus >>"$LOGFILE" 2>&1; then
        ok "Install ProtonPlus (second GUI fallback for GE-Proton/Wine-GE builds - some users have better luck with this one than ProtonUp-Qt)"
    else
        fail "Install ProtonPlus" "Run: flatpak install flathub com.vysp3r.ProtonPlus"
    fi
}

# ---------------------------------------------------------------------------
# GE-Proton (headless, via protonup-ng)
# ---------------------------------------------------------------------------

ensure_protonup_cli() {
    export PATH="$HOME/.local/bin:$PATH"
    if command -v protonup >/dev/null 2>&1; then
        return 0
    fi
    pipx ensurepath >>"$LOGFILE" 2>&1 || true
    if pipx install protonup-ng >>"$LOGFILE" 2>&1; then
        export PATH="$HOME/.local/bin:$PATH"
        command -v protonup >/dev/null 2>&1
        return $?
    fi
    return 1
}

# protonup-ng's -d flag takes an INSTALL DIRECTORY, and -t takes a specific
# version TAG (e.g. "6.5-GE-2") - there is no "target application" flag.
# Bare "protonup -d <dir> -y" fetches and installs the latest release into
# that directory non-interactively, so each launcher just needs its own
# correct directory passed in.
install_geproton_into() {
    local label="$1" dir="$2"
    mkdir -p "$dir"
    protonup -d "$dir" -y >>"$LOGFILE" 2>&1
    # Don't trust protonup's exit code alone - it has been observed to
    # report success without actually leaving a usable build behind, so
    # verify a real subdirectory landed in $dir before calling this OK.
    if [ -n "$(find "$dir" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | head -1)" ]; then
        ok "Install latest GE-Proton for $label"
        return 0
    else
        fail "Install latest GE-Proton for $label" "protonup-ng did not leave a usable build in \"$dir\" (see $LOGFILE for its output). Install it manually via ProtonUp-Qt or ProtonPlus instead (both already installed) - open either one's GUI and install the latest GE-Proton build for $label."
        return 1
    fi
}

GEPROTON_STEAM_OK=false

setup_geproton() {
    if ensure_protonup_cli; then
        ok "Install protonup-ng (headless GE-Proton manager)"
        install_geproton_into "Steam" "$HOME/.steam/root/compatibilitytools.d" && GEPROTON_STEAM_OK=true
        install_geproton_into "Lutris" "$HOME/.local/share/lutris/runners/wine"
    else
        fail "Install protonup-ng (headless GE-Proton manager)" "Use ProtonUp-Qt's or ProtonPlus's GUI instead (both already installed) to install the latest GE-Proton for Steam and Lutris manually."
    fi
}

# Lutris shells out to winetricks (an old bash script) with the WINE path,
# and a space in a runner directory's name breaks that unquoted handoff -
# ProtonPlus in particular installs a build literally named "Proton-GE
# Latest" under runners/wine, which then fails with "WINE is ... which is
# neither on the path nor an executable file" even though the file exists.
# Rename any offending runner directories (from any tool, not just ours) to
# a safe equivalent, regardless of whether GE-Proton setup above succeeded.
sanitize_lutris_runner_names() {
    local base dir name newname renamed=()
    for base in "$HOME/.local/share/lutris/runners/wine" "$HOME/.local/share/lutris/runners/proton"; do
        [ -d "$base" ] || continue
        while IFS= read -r -d '' dir; do
            name="$(basename "$dir")"
            case "$name" in
                *' '*)
                    newname="${name// /-}"
                    if [ -e "$base/$newname" ]; then
                        continue
                    fi
                    if mv "$dir" "$base/$newname" >>"$LOGFILE" 2>&1; then
                        renamed+=("$name -> $newname")
                    fi
                    ;;
            esac
        done < <(find "$base" -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null)
    done

    if [ ${#renamed[@]} -eq 0 ]; then
        ok "Check Lutris runner directory names for spaces (winetricks compatibility)"
    else
        ok "Renamed Lutris runner director$([ ${#renamed[@]} -eq 1 ] && echo y || echo ies) to remove spaces (winetricks compatibility): ${renamed[*]}"
        manual "Lutris: re-select the renamed Wine/Proton version in any affected game's Configure > Runner options - Lutris may still show the old name with the space cached until you do. Renamed: ${renamed[*]}"
    fi
}

# ---------------------------------------------------------------------------
# Battle.net (best-effort, via Lutris)
# ---------------------------------------------------------------------------

install_battlenet() {
    local desc="Install Battle.net (via Lutris)"

    if [ "$HAS_DISPLAY" != true ]; then
        manual "Battle.net: no graphical session was detected while this script ran. After logging into your desktop, open Lutris, search for 'Battle.net' in the installer library, click Install, and log in with your Blizzard account."
        return
    fi

    local lutris_bin="lutris"
    if ! command -v lutris >/dev/null 2>&1; then
        if flatpak list 2>/dev/null | grep -q net.lutris.Lutris; then
            lutris_bin="flatpak run net.lutris.Lutris"
        else
            fail "$desc" "Install Lutris first, then open it, search for 'Battle.net', and click Install."
            return
        fi
    fi

    if timeout 120 $lutris_bin -i battlenet >>"$LOGFILE" 2>&1; then
        ok "Trigger Battle.net install via Lutris"
        manual "Battle.net: finish the Lutris install (it downloads the Blizzard client in the background) and log in with your Blizzard account."
    else
        fail "$desc" "Open Lutris, search for 'Battle.net' in the installer library, and click Install. Log in with your Blizzard account when prompted."
    fi
}

# ---------------------------------------------------------------------------
# GPU driver guidance (informational only - not auto-installed)
# ---------------------------------------------------------------------------

check_gpu() {
    detect_gpu_vendor

    # AMD/Intel need no extra manual note here - Fedora's Mesa is already
    # refreshed every ~13 weeks with each release, so there's nothing
    # actionable to add beyond what install_core_deps already did.
    if [ "$GPU_VENDOR" = "nvidia" ]; then
        manual "NVIDIA GPU detected: install the proprietary driver via RPM Fusion (enabled by this script) - run 'sudo dnf install akmod-nvidia xorg-x11-drv-nvidia-cuda', wait about 5 minutes after reboot for the akmod to finish building, then reboot again if needed."
    fi

    ok "Detect GPU vendor for driver guidance (found: ${GPU_VENDOR:-none detected})"
}

# ---------------------------------------------------------------------------
# Static manual steps that always apply regardless of what succeeded/failed
# ---------------------------------------------------------------------------

add_static_manual_notes() {
    if [ "$GEPROTON_STEAM_OK" = true ]; then
        manual "Steam: launch it once, log in, then go to Settings > Compatibility, enable 'Enable Steam Play for all other titles', and select the GE-Proton build installed by this script as the default."
    else
        manual "Steam: launch it once, log in, then go to Settings > Compatibility, enable 'Enable Steam Play for all other titles'. GE-Proton wasn't installed automatically (see the failed step above) - install a build via ProtonUp-Qt or ProtonPlus first (both already installed), then select it as default."
    fi

    manual "Heroic: log in with your Epic Games account (Heroic > Epic Games Store > Login) to sync your Epic library. Heroic manages its own GE-Proton/Wine-GE builds under Settings > Wine Manager - install a build there directly rather than relying on Steam's or Lutris's copy."

    manual "Ubisoft Connect (Far Cry titles): log in with your Ubisoft account the first time you launch one. 'An error occurred while trying to send your request' is a generic Ubisoft client-side error (not specific to Linux) with no single fix - things worth trying in order: (1) switch the Wine/Proton-GE version it runs under (Lutris: right-click the game > Configure > Runner options; Steam: pick a different GE-Proton build under that game's Properties > Compatibility) - see community fixes at https://github.com/lutris/lutris/issues/4836 and https://forums.lutris.net/t/ubisoft-connect-not-working-solved/17438, (2) check your system clock/timezone is correct, since a wrong clock breaks TLS certificate validation, (3) as a fallback, sideload Ubisoft Connect inside Heroic instead (a separate, isolated Wine build) - download the installer from https://ubisoftconnect.com then follow the exact steps at https://github.com/Heroic-Games-Launcher/HeroicGamesLauncher/wiki/How-to-install-Ubisoft-Connect-on-Linux-and-Mac."

    manual "Nobara only: most of the above (Steam, Lutris, Wine, GPU drivers, Proton-GE) is likely already set up by the Nobara Welcome app - the steps above should mostly report 'already installed'; this script mainly fills in Heroic, ProtonUp-Qt/ProtonPlus, and the Battle.net trigger, which Welcome doesn't cover."
}

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

print_report() {
    local i

    echo
    echo "==================== Completed steps ===================="
    if [ ${#COMPLETED[@]} -eq 0 ]; then
        echo "(none)"
    else
        for i in "${!COMPLETED[@]}"; do
            echo "${COMPLETED_NUM[$i]}. ${COMPLETED[$i]}"
        done
    fi

    echo
    echo "==================== Failed steps ===================="
    if [ ${#FAILED[@]} -eq 0 ]; then
        echo "(none)"
    else
        for i in "${!FAILED[@]}"; do
            echo "${FAILED_NUM[$i]}. ${FAILED[$i]}"
        done
    fi

    echo
    echo "==================== Manual steps required ===================="
    if [ ${#MANUAL[@]} -eq 0 ] && [ ${#FAILED[@]} -eq 0 ]; then
        echo "(none)"
    else
        local n=0
        for item in "${MANUAL[@]}"; do
            n=$((n + 1))
            echo "$n. $item"
        done
        for i in "${!FAILED[@]}"; do
            n=$((n + 1))
            echo "$n. Resolve step ${FAILED_NUM[$i]} (${FAILED[$i]}): ${FAILED_RESOLUTIONS[$i]}"
        done
    fi

    echo
    echo "Full command output logged to: $LOGFILE"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
    precheck_distro

    echo "Refreshing dnf metadata..."
    if $SUDO dnf makecache >>"$LOGFILE" 2>&1; then
        ok "Refresh dnf package metadata"
    else
        fail "Refresh dnf package metadata" "Run: sudo dnf makecache, check your network/mirror configuration, then re-run this script."
    fi

    install_core_deps
    enable_rpmfusion
    install_steam
    install_lutris
    install_heroic
    install_protonup_qt
    install_protonplus
    setup_geproton
    sanitize_lutris_runner_names
    install_battlenet
    check_gpu
    add_static_manual_notes

    print_report
}

main "$@"
