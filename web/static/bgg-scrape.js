(async () => {
    if (!location.host.endsWith("boardgamegeek.com")) {
        alert("Run this snippet on a boardgamegeek.com tab.");
        return;
    }
    const username = prompt("BGG username:", "filecore");
    if (!username) return;
    const cr = await fetch(`/xmlapi2/collection?username=${username}&own=1`);
    if (!cr.ok) {
        alert("Collection fetch failed: HTTP " + cr.status);
        return;
    }
    const cxml = new DOMParser().parseFromString(await cr.text(), "text/xml");
    const ids = [...cxml.querySelectorAll("item")]
        .map((i) => i.getAttribute("objectid"))
        .filter(Boolean);
    if (!ids.length) {
        alert("No owned items found.");
        return;
    }
    console.log(`Found ${ids.length} games. Fetching images in batches...`);

    const rows = [];
    const BATCH = 20;
    for (let i = 0; i < ids.length; i += BATCH) {
        const batch = ids.slice(i, i + BATCH);
        const tr = await fetch(`/xmlapi2/thing?id=${batch.join(",")}`);
        if (!tr.ok) {
            console.warn(`Batch starting ${i} failed: ${tr.status}`);
            await new Promise((r) => setTimeout(r, 2000));
            continue;
        }
        const xml = new DOMParser().parseFromString(await tr.text(), "text/xml");
        for (const item of xml.querySelectorAll("item")) {
            const namePrim = item.querySelector('name[type="primary"]');
            rows.push({
                objectid: item.getAttribute("id"),
                objectname: namePrim ? namePrim.getAttribute("value") : "",
                image: item.querySelector("image")?.textContent || "",
                thumbnail: item.querySelector("thumbnail")?.textContent || "",
                minplayers: item.querySelector("minplayers")?.getAttribute("value") || "",
                maxplayers: item.querySelector("maxplayers")?.getAttribute("value") || "",
                yearpublished: item.querySelector("yearpublished")?.getAttribute("value") || "",
            });
        }
        console.log(`Progress: ${Math.min(i + BATCH, ids.length)} / ${ids.length}`);
        await new Promise((r) => setTimeout(r, 1500));
    }

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
        .concat(rows.map((r) => headers.map((h) => esc(r[h] || "")).join(",")))
        .join("\n");

    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "bgg-images.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    alert(`Downloaded ${rows.length} entries to bgg-images.csv`);
})();
