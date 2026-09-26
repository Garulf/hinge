import { expect, test } from "vitest";
import { TurnRoom } from "../../src/shared/turn-room";

const RESERVE = { x: 220, y: 280 };
const NONE = { x: 0, y: 0 };

test("an unturned phone asks for no room", () => {
  const room = new TurnRoom();
  expect(room.update(NONE, RESERVE, 0)).toEqual(NONE);
  expect(room.update(NONE, RESERVE, 5000)).toEqual(NONE);
});

test("the first frame a turn needs any room takes all a turn could need, and a whole drag keeps exactly that", () => {
  const room = new TurnRoom();
  expect(room.update({ x: 0, y: 3 }, RESERVE, 0)).toEqual(RESERVE);
  const during = [1, 12, 40, 97, 160, 71, 0, 0, 30].map((need, i) => room.update({ x: need / 2, y: need }, RESERVE, 16 * (i + 1)));
  expect(during).toEqual(during.map(() => RESERVE));
});

test("the room is given back once the phone has fitted the work view's window for half a second, not before", () => {
  const room = new TurnRoom();
  room.update({ x: 5, y: 9 }, RESERVE, 0);
  expect(room.update(NONE, RESERVE, 100)).toEqual(RESERVE);
  expect(room.update(NONE, RESERVE, 599)).toEqual(RESERVE);
  expect(room.update(NONE, RESERVE, 600)).toEqual(NONE);
});

test("needing room again while waiting to give it back starts the wait over", () => {
  const room = new TurnRoom();
  room.update({ x: 5, y: 9 }, RESERVE, 0);
  room.update(NONE, RESERVE, 100);
  room.update({ x: 0, y: 2 }, RESERVE, 400);
  expect(room.update(NONE, RESERVE, 800)).toEqual(RESERVE);
  expect(room.update(NONE, RESERVE, 1000)).toEqual(RESERVE);
  expect(room.update(NONE, RESERVE, 1400)).toEqual(NONE);
});

test("a new reserve (the phone folded or was scaled) applies at once while room is held", () => {
  const room = new TurnRoom();
  room.update({ x: 5, y: 9 }, RESERVE, 0);
  expect(room.update({ x: 5, y: 9 }, { x: 120, y: 150 }, 16)).toEqual({ x: 120, y: 150 });
});

test("a need past the reserve still gets its room", () => {
  const room = new TurnRoom();
  expect(room.update({ x: 230, y: 10 }, RESERVE, 0)).toEqual({ x: 230, y: 280 });
});

test("release gives the room back at once, and the next turn takes it again", () => {
  const room = new TurnRoom();
  room.update({ x: 5, y: 9 }, RESERVE, 0);
  room.release();
  expect(room.update(NONE, RESERVE, 16)).toEqual(NONE);
  expect(room.update({ x: 1, y: 0 }, RESERVE, 32)).toEqual(RESERVE);
});
