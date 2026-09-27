import { expect, test } from "vitest";
import { TurnRoom } from "../../src/shared/turn-room";

const RESERVE = { x: 220, y: 280 };
const NONE = { x: 0, y: 0 };
const TURNED = { need: NONE, straightOn: false };
const STRAIGHT = { need: NONE, straightOn: true };

function needing(x: number, y: number) {
  return { need: { x, y }, straightOn: false };
}

test("an unturned phone asks for no room", () => {
  const room = new TurnRoom();
  expect(room.update(STRAIGHT, RESERVE, 0)).toEqual(NONE);
  expect(room.update(STRAIGHT, RESERVE, 5000)).toEqual(NONE);
});

test("a turn that never reaches past the work view's window takes no room", () => {
  const room = new TurnRoom();
  expect(room.update(TURNED, RESERVE, 0)).toEqual(NONE);
});

test("the first frame a turn needs any room takes all a turn could need, and a whole drag keeps exactly that", () => {
  const room = new TurnRoom();
  expect(room.update(needing(0, 3), RESERVE, 0)).toEqual(RESERVE);
  const during = [1, 12, 40, 97, 160, 71, 0, 0, 30].map((need, i) => room.update(needing(need / 2, need), RESERVE, 16 * (i + 1)));
  expect(during).toEqual(during.map(() => RESERVE));
});

test("a turned phone keeps its room even where it would fit the work view's window, however long it stays there", () => {
  const room = new TurnRoom();
  room.update(needing(5, 9), RESERVE, 0);
  expect(room.update(TURNED, RESERVE, 100)).toEqual(RESERVE);
  expect(room.update(TURNED, RESERVE, 60_000)).toEqual(RESERVE);
});

test("the room is given back once the phone has been straight on for half a second, not before", () => {
  const room = new TurnRoom();
  room.update(needing(5, 9), RESERVE, 0);
  expect(room.update(STRAIGHT, RESERVE, 100)).toEqual(RESERVE);
  expect(room.update(STRAIGHT, RESERVE, 599)).toEqual(RESERVE);
  expect(room.update(STRAIGHT, RESERVE, 600)).toEqual(NONE);
});

test("turning away again while waiting to give the room back starts the wait over", () => {
  const room = new TurnRoom();
  room.update(needing(5, 9), RESERVE, 0);
  room.update(STRAIGHT, RESERVE, 100);
  room.update(TURNED, RESERVE, 400);
  expect(room.update(STRAIGHT, RESERVE, 800)).toEqual(RESERVE);
  expect(room.update(STRAIGHT, RESERVE, 1299)).toEqual(RESERVE);
  expect(room.update(STRAIGHT, RESERVE, 1300)).toEqual(NONE);
});

test("a new reserve (the phone folded or was scaled) applies at once while room is held", () => {
  const room = new TurnRoom();
  room.update(needing(5, 9), RESERVE, 0);
  expect(room.update(TURNED, { x: 120, y: 150 }, 16)).toEqual({ x: 120, y: 150 });
});

test("a need past the reserve still gets its room", () => {
  const room = new TurnRoom();
  expect(room.update(needing(230, 10), RESERVE, 0)).toEqual({ x: 230, y: 280 });
});

test("release gives the room back at once, and the next turn takes it again", () => {
  const room = new TurnRoom();
  room.update(needing(5, 9), RESERVE, 0);
  room.release();
  expect(room.update(TURNED, RESERVE, 16)).toEqual(NONE);
  expect(room.update(needing(1, 0), RESERVE, 32)).toEqual(RESERVE);
});
