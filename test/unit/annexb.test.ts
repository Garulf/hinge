import { expect, test } from "vitest";
import { groupAccessUnits, nalType, splitNalUnits } from "../../src/shared/annexb";

const sc4 = [0, 0, 0, 1];
const sc3 = [0, 0, 1];
const nal = (type: number, sc = sc4, body = [0xaa]) => [...sc, type, ...body];

test("splits on 3 and 4 byte start codes and keeps them", () => {
  const stream = new Uint8Array([...nal(0x67), ...nal(0x68, sc3), ...nal(0x65)]);
  const nals = splitNalUnits(stream);
  expect(nals.map(nalType)).toEqual([7, 8, 5]);
  expect(Array.from(nals[1])).toEqual([0, 0, 1, 0x68, 0xaa]);
});

test("SPS and PPS become config, IDR is a keyframe, P slices are not", () => {
  const nals = splitNalUnits(new Uint8Array([...nal(0x67), ...nal(0x68), ...nal(0x06), ...nal(0x65), ...nal(0x41), ...nal(0x41)]));
  const aus = groupAccessUnits(nals);
  expect(aus).toHaveLength(3);
  expect(aus[0].config && Array.from(aus[0].config).length).toBe(12);
  expect(aus[0].keyframe).toBe(true);
  expect(nalType(splitNalUnits(aus[0].data)[0])).toBe(6);
  expect(aus[1]).toMatchObject({ config: null, keyframe: false });
});
