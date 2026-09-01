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

COMPLETED=()
FAILED=()
FAILED_RESOLUTIONS=()
MANUAL=()

ok() {
    COMPLETED+=("$1")
    echo "[OK]     $1"
}

fail() {
    FAILED+=("$1")
    FAILED_RESOLUTIONS+=("$2")
    echo "[FAILED] $1"
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

install_geproton_for() {
    local target="$1"
    if protonup -d -t "$target" >>"$LOGFILE" 2>&1; then
        ok "Install latest GE-Proton for $target"
    else
        fail "Install latest GE-Proton for $target" "Open ProtonUp-Qt (already installed) and install the latest GE-Proton build for $target from its GUI. This usually just needs $target to have been run at least once first."
    fi
}

setup_geproton() {
    if ensure_protonup_cli; then
        ok "Install protonup-ng (headless GE-Proton manager)"
        install_geproton_for "Steam"
        install_geproton_for "Lutris"
        install_geproton_for "Heroic Games Launcher"
    else
        fail "Install protonup-ng (headless GE-Proton manager)" "Use ProtonUp-Qt's GUI instead (already installed) to install the latest GE-Proton for Steam, Lutris, and Heroic manually."
    fi
}

# ---------------------------------------------------------------------------
# Battle.net (best-effort, via Lutris)
# ---------------------------------------------------------------------------

install_battlenet() {
    local desc="Install Battle.net (via Lutris)"

    if [ "$HAS_DISPLAY" != true ]; then
        manual "Battle.net: no graphical session was detected while this script ran. After logging into your desktop, open Lutris, search for 'Battle.net' in the installer library, click Install, and log in with your Blizzard account (the same StarCraft II workaround you've used before)."
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
        fail "$desc" "Open Lutris, search for 'Battle.net' in the installer library, and click Install. Log in with your Blizzard account when prompted (the same StarCraft II workaround you've used before)."
    fi
}

# ---------------------------------------------------------------------------
# GPU driver guidance (informational only - not auto-installed)
# ---------------------------------------------------------------------------

check_gpu() {
    detect_gpu_vendor

    if [ "$GPU_VENDOR" = "nvidia" ]; then
        manual "NVIDIA GPU detected: install the proprietary driver via RPM Fusion (enabled by this script) - run 'sudo dnf install akmod-nvidia xorg-x11-drv-nvidia-cuda', wait about 5 minutes after reboot for the akmod to finish building, then reboot again if needed."
    elif [ "$GPU_VENDOR" = "amd" ]; then
        manual "AMD GPU detected: Fedora's default Mesa (installed by this script) is already refreshed roughly every 13 weeks with each Fedora release, so it stays close to upstream - no extra driver PPA/repo equivalent is needed here."
    elif [ "$GPU_VENDOR" = "intel" ]; then
        manual "Intel GPU detected: Mesa's ANV Vulkan driver (installed by this script) covers this - make sure your kernel is reasonably recent."
    fi

    ok "Detect GPU vendor for driver guidance"
}

# ---------------------------------------------------------------------------
# Static manual steps that always apply regardless of what succeeded/failed
# ---------------------------------------------------------------------------

add_static_manual_notes() {
    manual "Steam: launch it once, log in, then go to Settings > Compatibility, enable 'Enable Steam Play for all other titles', and select the GE-Proton build installed by this script as the default."
    manual "Heroic: log in with your Epic Games account (Heroic > Epic Games Store > Login) to sync your Epic library."
    manual "Ubisoft Connect (Far Cry titles): log in with your Ubisoft account the first time you launch one via Steam+Proton. If login fails (known Ubisoft Connect client bug under stock Proton since April 2026), use the GE-Proton build installed above, or sideload Ubisoft Connect inside Heroic as a fallback."
    manual "Nobara only: most of the above (Steam, Lutris, Wine, GPU drivers, Proton-GE) is likely already set up by the Nobara Welcome app - the steps above should mostly report 'already installed'; this script mainly fills in Heroic, ProtonUp-Qt, and the Battle.net trigger, which Welcome doesn't cover."
}

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

print_report() {
    echo
    echo "==================== Completed steps ===================="
    if [ ${#COMPLETED[@]} -eq 0 ]; then
        echo "(none)"
    else
        for item in "${COMPLETED[@]}"; do
            echo "- $item"
        done
    fi

    echo
    echo "==================== Failed steps ===================="
    if [ ${#FAILED[@]} -eq 0 ]; then
        echo "(none)"
    else
        for item in "${FAILED[@]}"; do
            echo "- $item"
        done
    fi

    echo
    echo "==================== Manual steps required ===================="
    if [ ${#MANUAL[@]} -eq 0 ] && [ ${#FAILED[@]} -eq 0 ]; then
        echo "(none)"
    else
        for item in "${MANUAL[@]}"; do
            echo "- $item"
        done
        local i
        for i in "${!FAILED[@]}"; do
            echo "- Resolve '${FAILED[$i]}': ${FAILED_RESOLUTIONS[$i]}"
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
    setup_geproton
    install_battlenet
    check_gpu
    add_static_manual_notes

    print_report
}

main "$@"
