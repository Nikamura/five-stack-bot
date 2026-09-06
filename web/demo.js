/** This fixture is imported only in explicit demo mode and never sends network requests. */
export function createDemo() {
  const serverStart = Date.UTC(2026, 8, 6, 8, 45);
  const startedAt = performance.now();
  const session = {
    id: 1, date: '2026-09-06', timezone: 'Europe/Vilnius', openerName: 'Tomas',
    startMinutes: 720, endMinutes: 1320, closesAt: Date.UTC(2026, 8, 6, 19),
    closed: false, validStacks: [5, 3, 2],
  };
  const minutes = Array.from({ length: 20 }, (_, index) => 720 + index * 30);
  const votesFor = (from, to, value = 'yes') => minutes.map((slot) => ({ slot, value: slot >= from && slot <= to ? value : 'no' }));
  const players = [
    { id: 1, displayName: 'You', username: null, responded: false, skipped: false, filler: false, votes: [], lateMinutes: 0 },
    { id: 2, displayName: 'Tomas', username: 'tomas', responded: true, skipped: false, filler: false, votes: votesFor(780, 1080), lateMinutes: 0 },
    { id: 3, displayName: 'Mantas', username: 'mantas', responded: true, skipped: false, filler: false, votes: votesFor(1020, 1290), lateMinutes: 0 },
    { id: 4, displayName: 'Justas', username: 'justas', responded: true, skipped: false, filler: false, votes: votesFor(1080, 1200, 'maybe'), lateMinutes: 0 },
    { id: 5, displayName: 'Aurimas', username: 'aurimas', responded: false, skipped: false, filler: false, votes: [], lateMinutes: 0 },
  ];
  let revision = 0;
  let simulated = false;
  function snapshot() {
    const slots = minutes.map((slot) => {
      const valueFor = (player) => player.votes.find((vote) => vote.slot === slot)?.value;
      const yesUserIds = players.filter((player) => !player.filler && valueFor(player) === 'yes').map((player) => player.id);
      const maybeUserIds = players.filter((player) => !player.filler && valueFor(player) === 'maybe').map((player) => player.id);
      const fillerUserIds = players.filter((player) => player.filler && ['yes', 'maybe'].includes(valueFor(player))).map((player) => player.id);
      const no = players.filter((player) => valueFor(player) === 'no').length;
      return {
        minutes: slot, startsAt: Date.UTC(2026, 8, 6, 0, slot - 180),
        yes: yesUserIds.length, maybe: maybeUserIds.length, filler: fillerUserIds.length,
        no, notVoted: players.length - yesUserIds.length - maybeUserIds.length - fillerUserIds.length - no,
        yesUserIds, maybeUserIds, fillerUserIds,
      };
    });
    return structuredClone({
      session, serverNow: serverStart + performance.now() - startedAt, players, slots,
      me: { id: 1, revision: `demo-${revision}`, responded: players[0].responded, skipped: false, filler: players[0].filler, votes: players[0].votes },
      lock: null,
    });
  }
  return {
    snapshot,
    save(input) {
      const values = new Map(input.votes.map((vote) => [vote.slot, vote.value]));
      players[0].votes = minutes.map((slot) => ({ slot, value: values.get(slot) || 'no' }));
      players[0].responded = true;
      players[0].filler = input.filler;
      revision += 1;
      return snapshot();
    },
    simulate() {
      simulated = !simulated;
      players[4].votes = simulated ? votesFor(1080, 1200) : votesFor(-1, -1);
      players[4].responded = true;
      return { snapshot: snapshot(), message: simulated ? 'Aurimas saved 18:00–20:00.' : 'Aurimas saved “Can’t play”.' };
    },
  };
}
