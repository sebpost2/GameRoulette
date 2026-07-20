import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetchOwnedGames, searchStoreGames } from '../src/steam.js';

describe('fetchOwnedGames', () => {
  test('returns the games array from a successful Steam API response', async () => {
    const fetchImpl = async (url) => {
      assert.match(url, /GetOwnedGames/);
      assert.match(url, /steamid=76561198000000000/);
      assert.match(url, /key=TESTKEY/);
      return {
        ok: true,
        json: async () => ({
          response: { games: [{ appid: 620, name: 'Portal 2', playtime_forever: 100 }] },
        }),
      };
    };

    const games = await fetchOwnedGames('76561198000000000', { apiKey: 'TESTKEY', fetchImpl });
    assert.deepEqual(games, [{ appid: 620, name: 'Portal 2', playtime_forever: 100 }]);
  });

  test('returns an empty array when the profile has no games field', async () => {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ response: {} }) });
    const games = await fetchOwnedGames('123', { apiKey: 'TESTKEY', fetchImpl });
    assert.deepEqual(games, []);
  });

  test('throws when the Steam API responds with an error status', async () => {
    const fetchImpl = async () => ({ ok: false, status: 403 });
    await assert.rejects(() => fetchOwnedGames('123', { apiKey: 'BAD', fetchImpl }));
  });
});

describe('searchStoreGames', () => {
  test('maps store search results to appid/title/cover_url', async () => {
    const fetchImpl = async (url) => {
      assert.match(url, /storesearch/);
      assert.match(url, /term=call%20of%20duty/);
      return {
        ok: true,
        json: async () => ({
          items: [
            { id: 1938090, name: 'Call of Duty: Modern Warfare II', tiny_image: 'https://example.com/cod.jpg' },
            { id: 10090, name: 'Call of Duty: World at War', tiny_image: null },
          ],
        }),
      };
    };

    const results = await searchStoreGames('call of duty', { fetchImpl });
    assert.deepEqual(results, [
      { appid: 1938090, title: 'Call of Duty: Modern Warfare II', cover_url: 'https://example.com/cod.jpg' },
      { appid: 10090, title: 'Call of Duty: World at War', cover_url: null },
    ]);
  });

  test('returns an empty array when there are no items', async () => {
    const fetchImpl = async () => ({ ok: true, json: async () => ({}) });
    const results = await searchStoreGames('asdf', { fetchImpl });
    assert.deepEqual(results, []);
  });

  test('caps results at 10', async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ id: i, name: `Game ${i}`, tiny_image: null }));
    const fetchImpl = async () => ({ ok: true, json: async () => ({ items }) });
    const results = await searchStoreGames('game', { fetchImpl });
    assert.equal(results.length, 10);
  });

  test('throws when the store search responds with an error status', async () => {
    const fetchImpl = async () => ({ ok: false, status: 500 });
    await assert.rejects(() => searchStoreGames('x', { fetchImpl }));
  });
});
