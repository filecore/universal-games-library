(async () => {
    if (!location.host.endsWith("boardgamegeek.com")) {
        alert("Run this snippet on a boardgamegeek.com tab.");
        return;
    }
    const username = prompt("BGG username:", "filecore");
    if (!username) return;

    // BGG's collection endpoint already returns <image>, <thumbnail>, and
    // <stats minplayers maxplayers ...> per item when stats=1 is set.
    // The /thing endpoint is currently 401 even in browser context, so we
    // rely entirely on this one call.
    const r = await fetch(
        `/xmlapi2/collection?username=${encodeURIComponent(username)}&own=1&stats=1`,
    );
    if (!r.ok) {
        alert(`Collection fetch failed: HTTP ${r.status}`);
        return;
    }
    const xml = new DOMParser().parseFromString(await r.text(), "text/xml");
    const items = [...xml.querySelectorAll("item")];
    if (!items.length) {
        alert("No owned items found.");
        return;
    }
    console.log(`Found ${items.length} items. Building CSV...`);

    const rows = items.map((item) => {
        const stats = item.querySelector("stats");
        return {
            objectid: item.getAttribute("objectid") || "",
            objectname: item.querySelector("name")?.textContent || "",
            image: item.querySelector("image")?.textContent || "",
            thumbnail: item.querySelector("thumbnail")?.textContent || "",
            minplayers: stats?.getAttribute("minplayers") || "",
            maxplayers: stats?.getAttribute("maxplayers") || "",
            yearpublished: item.querySelector("yearpublished")?.textContent || "",
        };
    });

    const headers = [
        "objectid",
        "objectname",
        "image",
        "thumbnail",
        "minplayers",
        "maxplayers",
        "yearpublished",
    ];
    const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const csv = [headers.join(",")]
        .concat(rows.map((row) => headers.map((h) => esc(row[h] || "")).join(",")))
        .join("\n");

    const withImage = rows.filter((r) => r.image || r.thumbnail).length;
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "bgg-images.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    alert(
        `Downloaded ${rows.length} entries (${withImage} with image URLs) to bgg-images.csv`,
    );
})();
