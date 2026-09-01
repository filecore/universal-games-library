#!/usr/bin/env bash
# One-time bootstrap for a Debian-based desktop (Ubuntu, Linux Mint, Debian)
# to reach a game-ready state: Steam, Lutris, Heroic, ProtonUp-Qt, headless
# GE-Proton installs, core Wine/Vulkan dependencies, and a best-effort
# Battle.net install via Lutris.
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

precheck_distro() {
    if [ ! -f /etc/debian_version ]; then
        echo "This script targets Debian-based distributions (Ubuntu, Linux Mint, Debian). Aborting." >&2
        exit 1
    fi
}

IS_UBUNTU_BASED=false
DEBIAN_CODENAME=""

detect_distro_flavor() {
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        DEBIAN_CODENAME="${VERSION_CODENAME:-}"
        if [ "${ID:-}" = "ubuntu" ] || [ "${ID:-}" = "linuxmint" ] || [[ "${ID_LIKE:-}" == *ubuntu* ]]; then
            IS_UBUNTU_BASED=true
        fi
    fi
}

GPU_VENDOR=""

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
    local pkgs=(wine winetricks cabextract p7zip-full unzip curl wget gnupg
        ca-certificates software-properties-common flatpak
        mesa-vulkan-drivers libvulkan1 vulkan-tools gamemode pipx)

    if $SUDO apt-get install -y "${pkgs[@]}" >>"$LOGFILE" 2>&1; then
        ok "Install core dependencies (wine, winetricks, Vulkan drivers, gamemode, pipx, flatpak, etc.)"
        return
    fi

    echo "Batch install failed, retrying packages individually to isolate failures" >>"$LOGFILE"
    local bad=()
    for p in "${pkgs[@]}"; do
        if ! $SUDO apt-get install -y "$p" >>"$LOGFILE" 2>&1; then
            bad+=("$p")
        fi
    done

    if [ ${#bad[@]} -eq 0 ]; then
        ok "Install core dependencies (wine, winetricks, Vulkan drivers, gamemode, pipx, flatpak, etc.)"
    else
        fail "Install core dependencies" "The following packages failed to install: ${bad[*]}. Run 'apt-cache search <name>' to find the correct package name for your distro/release, then install manually with apt."
    fi
}

ensure_flatpak() {
    if ! command -v flatpak >/dev/null 2>&1; then
        $SUDO apt-get install -y flatpak >>"$LOGFILE" 2>&1 || return 1
    fi
    $SUDO flatpak remote-add --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo >>"$LOGFILE" 2>&1
}

# Ubuntu/Mint only: the kisak-mesa PPA tracks upstream Mesa releases much
# faster than the distro repos, which matters for RADV/ANV (AMD/Intel)
# Vulkan performance and bug fixes. Not applicable to NVIDIA (proprietary
# driver, not Mesa) or to plain Debian (no PPA support).
freshen_mesa_ubuntu() {
    if [ "$IS_UBUNTU_BASED" != true ]; then
        return
    fi
    if [ "$GPU_VENDOR" != "amd" ] && [ "$GPU_VENDOR" != "intel" ]; then
        return
    fi
    if ! command -v add-apt-repository >/dev/null 2>&1; then
        fail "Add kisak-mesa PPA for newer Mesa" "Install software-properties-common, then run: sudo add-apt-repository ppa:kisak-mesalib/kisak-mesa && sudo apt-get update && sudo apt-get install --only-upgrade libgl1-mesa-dri mesa-vulkan-drivers mesa-utils"
        return
    fi
    if $SUDO add-apt-repository -y ppa:kisak-mesalib/kisak-mesa >>"$LOGFILE" 2>&1 \
        && $SUDO apt-get update -y >>"$LOGFILE" 2>&1 \
        && $SUDO apt-get install -y --only-upgrade libgl1-mesa-dri mesa-vulkan-drivers mesa-utils >>"$LOGFILE" 2>&1; then
        ok "Add kisak-mesa PPA and upgrade to its newer Mesa build"
    else
        fail "Add kisak-mesa PPA for newer Mesa" "Run: sudo add-apt-repository ppa:kisak-mesalib/kisak-mesa && sudo apt-get update && sudo apt-get install --only-upgrade libgl1-mesa-dri mesa-vulkan-drivers mesa-utils"
    fi
}

# Plain Debian only: Ubuntu/Mint already pull vendor firmware and CPU
# microcode from their default repos, but Debian splits proprietary
# firmware into the non-free-firmware component, which may not be enabled.
install_firmware_microcode_debian() {
    if [ "$IS_UBUNTU_BASED" != false ]; then
        return
    fi
    local pkgs=()
    if [ "$GPU_VENDOR" = "amd" ]; then
        pkgs=(firmware-amd-graphics amd64-microcode)
    elif [ "$GPU_VENDOR" = "intel" ]; then
        pkgs=(intel-microcode)
    else
        return
    fi
    if $SUDO apt-get install -y "${pkgs[@]}" >>"$LOGFILE" 2>&1; then
        ok "Install GPU firmware / CPU microcode (${pkgs[*]})"
    else
        local codename_hint="${DEBIAN_CODENAME:-<your-release-codename>}"
        fail "Install GPU firmware / CPU microcode (${pkgs[*]})" "Enable the 'non-free-firmware' component for '$codename_hint' in your APT sources (the Debian lines in /etc/apt/sources.list, or the deb822 file under /etc/apt/sources.list.d/), run 'sudo apt-get update', then 'sudo apt-get install ${pkgs[*]}'."
    fi
}

# ---------------------------------------------------------------------------
# Launchers
# ---------------------------------------------------------------------------

install_steam() {
    if command -v steam >/dev/null 2>&1; then
        ok "Steam (already installed)"
        return
    fi

    if $SUDO apt-get install -y steam-installer >>"$LOGFILE" 2>&1; then
        ok "Install Steam (steam-installer package)"
        return
    fi

    echo "steam-installer package unavailable, falling back to the official Valve .deb" >>"$LOGFILE"
    if wget -q -O /tmp/steam.deb https://cdn.akamai.steamstatic.com/client/installer/steam.deb >>"$LOGFILE" 2>&1 \
        && $SUDO apt-get install -y /tmp/steam.deb >>"$LOGFILE" 2>&1; then
        ok "Install Steam (official Valve .deb)"
    else
        fail "Install Steam" "Enable the 'multiverse' (Ubuntu/Mint) or 'contrib non-free' (Debian) repository components, run 'sudo apt-get update', then 'sudo apt-get install steam-installer'. Or download the installer directly from https://store.steampowered.com/about/."
    fi
}

install_lutris() {
    if command -v lutris >/dev/null 2>&1; then
        ok "Lutris (already installed)"
        return
    fi

    if $SUDO apt-get install -y lutris >>"$LOGFILE" 2>&1; then
        ok "Install Lutris (apt package)"
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
        manual "NVIDIA GPU detected: install the proprietary NVIDIA driver for full Vulkan/Proton performance. Ubuntu: run 'ubuntu-drivers autoinstall' or use Software & Updates > Additional Drivers. Mint: use the Driver Manager. Debian: enable contrib+non-free and install nvidia-driver. Reboot afterwards."
    elif [ "$GPU_VENDOR" = "amd" ]; then
        if [ "$IS_UBUNTU_BASED" = true ]; then
            manual "AMD GPU detected: this script already added the kisak-mesa PPA for a newer Mesa/RADV build - no further action needed."
        else
            manual "AMD GPU detected: this script already installed firmware-amd-graphics and amd64-microcode. If you still hit graphics glitches or missing features, Debian's stable kernel can lag behind newer AMD GPUs - consider a backports kernel: enable the '${DEBIAN_CODENAME:-<your-release-codename>}-backports' component in your APT sources, run 'sudo apt-get update', then 'sudo apt-get install -t ${DEBIAN_CODENAME:-<your-release-codename>}-backports linux-image-amd64'."
        fi
    elif [ "$GPU_VENDOR" = "intel" ]; then
        if [ "$IS_UBUNTU_BASED" = true ]; then
            manual "Intel GPU detected: this script already added the kisak-mesa PPA for a newer Mesa/ANV build - no further action needed."
        else
            manual "Intel GPU detected: this script already installed intel-microcode. Mesa's ANV Vulkan driver (installed by this script) covers the rest - make sure your kernel is reasonably recent."
        fi
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
    detect_distro_flavor
    detect_gpu_vendor

    echo "Updating package index..."
    if $SUDO apt-get update -y >>"$LOGFILE" 2>&1; then
        ok "Refresh package index (apt update)"
    else
        fail "Refresh package index (apt update)" "Run: sudo apt-get update, check your network/mirror configuration, then re-run this script."
    fi

    if $SUDO dpkg --add-architecture i386 >>"$LOGFILE" 2>&1 && $SUDO apt-get update -y >>"$LOGFILE" 2>&1; then
        ok "Enable 32-bit (i386) package architecture (required by Wine/Proton)"
    else
        fail "Enable 32-bit (i386) package architecture" "Run: sudo dpkg --add-architecture i386 && sudo apt-get update"
    fi

    install_core_deps
    install_firmware_microcode_debian
    install_steam
    install_lutris
    install_heroic
    install_protonup_qt
    setup_geproton
    freshen_mesa_ubuntu
    install_battlenet
    check_gpu
    add_static_manual_notes

    print_report
}

main "$@"
