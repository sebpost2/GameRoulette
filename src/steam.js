export async function fetchOwnedGames(steamId64, { apiKey, fetchImpl = fetch } = {}) {
  const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${apiKey}&steamid=${steamId64}&format=json&include_appinfo=1`;
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`Steam API error: ${res.status}`);
  }
  const data = await res.json();
  return data.response?.games ?? [];
}

export async function searchStoreGames(query, { fetchImpl = fetch } = {}) {
  const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(query)}&cc=us&l=english`;
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`Steam store search error: ${res.status}`);
  }
  const data = await res.json();
  const items = data.items ?? [];
  return items.slice(0, 10).map((i) => ({
    appid: i.id,
    title: i.name,
    cover_url: i.tiny_image ?? null,
  }));
}
