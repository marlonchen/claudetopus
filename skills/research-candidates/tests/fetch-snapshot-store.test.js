"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const { describe, it } = require("node:test");
const { BALLOT } = require("./harness");
const { COUNTY_PAGE, PLAIN, fetchVia, repo, sha256 } = require("./fetch-snapshot-fixture");

// fetch-snapshot's write-once store: the manifest save order, crash recovery
// and the per-ballot lock (snapshot-format.md, Manifest).

describe("snapshot-format.md, Manifest: a crash at any step leaves a state the next run repairs", () => {
  const routes = { "https://county.example.gov/": { body: COUNTY_PAGE } };
  // A killed run leaves its lock behind, which the next run takes over once it is
  // older than any save; age it so the rerun need not wait that long.
  const crash = async (data, step) => {
    const result = await fetchVia(data, routes, PLAIN, { RESEARCH_CANDIDATES_TEST_CRASH: step });
    const lock = data.file(`${BALLOT}/.lock/held`);
    assert.ok(fs.existsSync(lock), "the killed run left no lock");
    const past = new Date(Date.now() - 60 * 1000);
    fs.utimesSync(lock, past, past);
    return result;
  };
  const manifestLines = (data) =>
    data.read(`${BALLOT}/snapshots.sha256`).split("\n").filter(Boolean);
  // Every manifest line names a file on disk with that hash, and every file has a line.
  const assertConsistent = (data) => {
    const lines = manifestLines(data);
    for (const line of lines) {
      const [hash, rel] = line.split("  ");
      assert.equal(sha256(data.read(`${BALLOT}/${rel}`)), hash, rel);
    }
    const files = data.list(`${BALLOT}/sources/us-house-07/_race`);
    assert.equal(files.length, lines.length);
    assert.deepEqual(data.list(`${BALLOT}/.partial`), []);
  };

  it("discards a partial that never reached the manifest", async () => {
    const data = repo();
    const crashed = await crash(data, "after-partial");
    assert.equal(crashed.signal, "SIGKILL");
    assert.equal(data.list(`${BALLOT}/.partial`).length, 1);
    assert.ok(!data.exists(`${BALLOT}/snapshots.sha256`));

    const rerun = await fetchVia(data, routes, PLAIN);
    assert.equal(rerun.stdout, "sources/us-house-07/_race/county-page.md saved\n");
    assert.equal(manifestLines(data).length, 1);
    assertConsistent(data);
  });

  it("moves a partial whose manifest line was written into place", async () => {
    const data = repo();
    const crashed = await crash(data, "after-manifest");
    assert.equal(crashed.signal, "SIGKILL");
    assert.ok(!data.exists(`${BALLOT}/sources/us-house-07/_race/county-page.md`));

    const rerun = await fetchVia(data, routes, PLAIN);
    assert.equal(rerun.stdout, "sources/us-house-07/_race/county-page-2.md saved\n");
    assert.ok(data.exists(`${BALLOT}/sources/us-house-07/_race/county-page.md`));
    assertConsistent(data);
  });

  it("repairs before refusing, so a failed fetch still finishes an interrupted save", async () => {
    const data = repo();
    await crash(data, "after-manifest");
    const rerun = await fetchVia(data, {}, [
      BALLOT,
      "us-house-07",
      "_race",
      "x",
      "https://nowhere.example/",
    ]);
    assert.equal(rerun.status, 1);
    assert.ok(data.exists(`${BALLOT}/sources/us-house-07/_race/county-page.md`));
    assertConsistent(data);
  });

  it("drops a partial left behind after its file was linked into place", async () => {
    const data = repo();
    const crashed = await crash(data, "after-link");
    assert.equal(crashed.signal, "SIGKILL");
    assert.ok(data.exists(`${BALLOT}/sources/us-house-07/_race/county-page.md`));
    assert.equal(data.list(`${BALLOT}/.partial`).length, 1);

    const rerun = await fetchVia(data, routes, PLAIN);
    assert.equal(rerun.stdout, "sources/us-house-07/_race/county-page-2.md saved\n");
    assertConsistent(data);
  });

  it("deletes a stray .partial file no manifest line names", async () => {
    const data = repo();
    data.write(`${BALLOT}/.partial/${"0".repeat(64)}`, "stray");
    await fetchVia(data, routes, PLAIN);
    assertConsistent(data);
  });
});

describe("snapshot-format.md, Manifest: the ballot lock and recovery's limits", () => {
  const routes = { "https://county.example.gov/": { body: COUNTY_PAGE } };
  const lockFile = `${BALLOT}/.lock/held`;

  // A lock is judged by age alone: a pid means nothing across pid namespaces.
  const takesOver = (name, text, ageMs) =>
    it(name, async () => {
      const data = repo();
      data.write(lockFile, text);
      const when = new Date(Date.now() - ageMs);
      fs.utimesSync(data.file(lockFile), when, when);
      const result = await fetchVia(data, routes, PLAIN);
      assert.equal(result.stdout, "sources/us-house-07/_race/county-page.md saved\n");
      assert.deepEqual(data.list(`${BALLOT}/.lock`), []);
      assert.deepEqual(data.list(`${BALLOT}/.partial`), []);
    });
  takesOver("takes over an empty lock older than any save", "", 60 * 1000);
  takesOver(
    "takes over a lock older than any save, whatever pid it names",
    `${process.pid} x\n`,
    3600 * 1000,
  );
  takesOver("takes over a lock whose mtime is far in the future", "1 x\n", -3600 * 1000);

  it("refuses to append to a manifest whose last line has no newline", async () => {
    const data = repo();
    data.write(`${BALLOT}/snapshots.sha256`, "-  sources/us-house-07/_race/old.md");
    const result = await fetchVia(data, routes, PLAIN);
    assert.equal(result.stdout, "snapshots.sha256 manifest-invalid\n");
    assert.equal(data.read(`${BALLOT}/snapshots.sha256`), "-  sources/us-house-07/_race/old.md");
    assert.ok(!data.exists(`${BALLOT}/sources`));
  });

  it("never relinks a leftover partial to a manifest path outside sources/", async () => {
    const data = repo();
    const hash = sha256("planted");
    data.write(`${BALLOT}/.partial/${hash}`, "planted");
    data.write(`${BALLOT}/snapshots.sha256`, `${hash}  sources/../escaped.md\n`);
    await fetchVia(data, routes, PLAIN);
    assert.ok(!data.exists(`${BALLOT}/escaped.md`));
    assert.ok(!data.list(`${BALLOT}/.partial`).includes(hash));
  });

  it("removes a lock temp file a crash left, and keeps a fresh one", async () => {
    const data = repo();
    const old = `${BALLOT}/.lock/held.tmp-deadbeef`;
    const fresh = `${BALLOT}/.lock/held.tmp-cafef00d`;
    data.write(old, "1 x\n");
    const past = new Date(Date.now() - 60 * 1000);
    fs.utimesSync(data.file(old), past, past);
    data.write(fresh, "1 y\n");
    const result = await fetchVia(data, routes, PLAIN);
    assert.equal(result.stdout, "sources/us-house-07/_race/county-page.md saved\n");
    assert.ok(!data.exists(old));
    assert.ok(data.exists(fresh));
  });

  it("never places a leftover partial whose content does not hash to its name", async () => {
    const data = repo();
    const hash = sha256("the page as saved");
    data.write(`${BALLOT}/.partial/${hash}`, "the page as sav");
    data.write(`${BALLOT}/snapshots.sha256`, `${hash}  sources/us-house-07/_race/cut.md\n`);
    const result = await fetchVia(data, routes, PLAIN);
    assert.equal(result.stdout, "sources/us-house-07/_race/county-page.md saved\n");
    assert.ok(!data.exists(`${BALLOT}/sources/us-house-07/_race/cut.md`));
    assert.deepEqual(data.list(`${BALLOT}/.partial`), []);
  });
});
