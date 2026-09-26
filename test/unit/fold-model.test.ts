/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as THREE from "three";
import { beforeAll, expect, test } from "vitest";
import { FoldModel } from "../../src/renderer/scene/fold-model";
import { CREASE_STRENGTH, ScreenMaterial } from "../../src/renderer/scene/screen-material";
import { FOLD7_BODY } from "../../src/shared/layout";
import { streamSampleMatrix } from "../../src/shared/screen-uv";

let model: FoldModel;

beforeAll(async () => {
  const bytes = readFileSync(resolve("src/renderer/public/fold7.glb"));
  model = await FoldModel.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
});

function worldNormal(mesh: THREE.Mesh): THREE.Vector3 {
  const normals = mesh.geometry.getAttribute("normal");
  const sum = new THREE.Vector3();
  for (let i = 0; i < normals.count; i++) sum.add(new THREE.Vector3().fromBufferAttribute(normals, i));
  mesh.updateWorldMatrix(true, false);
  return sum.normalize().transformDirection(mesh.matrixWorld);
}

function worldCentre(mesh: THREE.Mesh): THREE.Vector3 {
  mesh.updateWorldMatrix(true, false);
  return new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
}

test("finds every node the model contract names", () => {
  for (const name of ["Root", "FixedHalf", "Hinge", "CoverHalf", "CoverScreen", "InnerScreen", "HingeFill", "Rig", "bone_fixed", "bone_cover"]) {
    expect(model.root.getObjectByName(name), name).toBeDefined();
  }
  expect(model.inner.mesh.isSkinnedMesh).toBe(true);
  expect(model.inner.extras.pixelSize).toEqual([1968, 2184]);
  expect(model.cover.extras.pixelSize).toEqual([1080, 2520]);
});

test("at 180 degrees the cover screen faces -Z and the inner screen +Z", () => {
  model.setAngle(180);
  expect(worldNormal(model.cover.mesh).z).toBeLessThan(-0.99);
  expect(worldNormal(model.inner.mesh).z).toBeGreaterThan(0.99);
});

test("at 0 degrees the cover screen faces +Z and sits over the fixed half", () => {
  model.setAngle(0);
  expect(worldNormal(model.cover.mesh).z).toBeGreaterThan(0.99);
  expect(worldCentre(model.cover.mesh).x).toBeGreaterThan(0);
});

test("bodyWidthMm follows the pose and matches the layout's body widths", () => {
  model.setAngle(180);
  expect(Math.abs(model.bodyWidthMm() - 143.7)).toBeLessThanOrEqual(0.3);
  expect(Math.abs(model.bodyWidthMm() - FOLD7_BODY.openWidthMm)).toBeLessThanOrEqual(0.3);
  model.setAngle(0);
  expect(Math.abs(model.bodyWidthMm() - FOLD7_BODY.closedWidthMm)).toBeLessThanOrEqual(0.3);
});

test("hiding the inner screen leaves HingeFill visible", () => {
  model.setInnerVisible(false);
  expect(model.root.getObjectByName("InnerScreen")?.visible).toBe(false);
  expect(model.root.getObjectByName("HingeFill")?.visible).toBe(true);
  model.setInnerVisible(true);
  expect(model.root.getObjectByName("InnerScreen")?.visible).toBe(true);
});

test("ScreenMaterial masks in screen pixels and samples through the rotation transform", () => {
  const material = new ScreenMaterial(model.inner.extras);
  const [w, h] = model.inner.extras.pixelSize;
  expect(material.uniforms.cornerRadiusPx.value).toBeCloseTo(model.inner.extras.cornerRadiusUv[0] * w, 0);
  expect(material.uniforms.punchHolePx.value.toArray()).toEqual([
    model.inner.extras.punchHole[0] * w,
    model.inner.extras.punchHole[1] * h,
    model.inner.extras.punchHole[2] * w,
  ]);
  expect(material.transparent).toBe(true);
  expect(material.toneMapped).toBe(false);

  material.setRotation(1);
  expect(material.uniforms.sampleMatrix.value.toArray()).toEqual(streamSampleMatrix(1));
  expect(material.uniforms.hasMap.value).toBe(false);
  const texture = new THREE.Texture();
  material.setVideo(texture);
  expect(material.uniforms.map.value).toBe(texture);
  expect(material.uniforms.hasMap.value).toBe(true);
  material.setBrightness(0.5);
  expect(material.uniforms.brightness.value).toBe(0.5);
});

test("poseBox follows the rigid halves: the body's width open and closed, and deeper when half open", () => {
  model.root.position.set(0, 0, 0);
  model.setAngle(180);
  const open = model.poseBox();
  expect(Math.abs((open.max.x - open.min.x) * 1000 - model.bodyWidthMm())).toBeLessThanOrEqual(0.5);
  expect(Math.abs((open.max.y - open.min.y) * 1000 - FOLD7_BODY.heightMm)).toBeLessThanOrEqual(0.5);

  model.setAngle(0);
  const closed = model.poseBox();
  expect(Math.abs((closed.max.x - closed.min.x) * 1000 - model.bodyWidthMm())).toBeLessThanOrEqual(0.5);

  model.setAngle(100);
  const half = model.poseBox();
  expect((half.max.z - half.min.z) * 1000).toBeGreaterThan(50);
  model.setAngle(180);
});

test("poseBox in an ancestor's frame ignores that ancestor's own transform, even while its world matrix is stale", () => {
  const scene = new THREE.Scene();
  const turn = new THREE.Group();
  turn.matrixAutoUpdate = false;
  const pivot = new THREE.Group();
  scene.add(turn);
  turn.add(pivot);
  pivot.add(model.root);
  try {
    pivot.rotation.z = Math.PI / 2;
    model.root.position.set(-0.07, -0.04, 0);
    model.setAngle(180);
    scene.updateMatrixWorld(true);
    const unturned = model.poseBox(new THREE.Box3(), turn).clone();

    const c = unturned.getCenter(new THREE.Vector3());
    const turned = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(-60), THREE.MathUtils.degToRad(75), 0, "XYZ"));
    turn.matrix.makeTranslation(c.x, c.y, c.z).multiply(turned).multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
    turn.matrixWorldNeedsUpdate = true;
    scene.updateMatrixWorld();

    turn.matrix.identity();
    const again = model.poseBox(new THREE.Box3(), turn);
    for (const key of ["min", "max"] as const) {
      for (const axis of ["x", "y", "z"] as const) expect(again[key][axis], `${key}.${axis}`).toBeCloseTo(unturned[key][axis], 9);
    }
  } finally {
    pivot.remove(model.root);
    model.root.position.set(0, 0, 0);
    model.root.updateMatrixWorld(true);
  }
});

test("both screens carry normals for the glass reflection", () => {
  expect(model.cover.mesh.geometry.getAttribute("normal")).toBeDefined();
  expect(model.inner.mesh.geometry.getAttribute("normal")).toBeDefined();
});

test("ScreenMaterial's glass is off by default and samples the environment's cube UV layout when one is given", () => {
  const material = new ScreenMaterial(model.inner.extras);
  expect(material.uniforms.glass.value).toBe(0);
  material.setGlass(0.7);
  expect(material.uniforms.glass.value).toBe(0.7);

  const env = new THREE.Texture({ width: 768, height: 1024 } as unknown as HTMLImageElement);
  env.mapping = THREE.CubeUVReflectionMapping;
  material.setEnvironment(env);
  expect(material.uniforms.envMap.value).toBe(env);
  expect(material.defines.ENVMAP_TYPE_CUBE_UV).toBe("");
  expect(Number(material.defines.CUBEUV_MAX_MIP)).toBe(8);
  expect(Number(material.defines.CUBEUV_TEXEL_HEIGHT)).toBeCloseTo(1 / 1024, 12);
  expect(Number(material.defines.CUBEUV_TEXEL_WIDTH)).toBeCloseTo(1 / (3 * 256), 12);

  material.setEnvironment(null);
  expect(material.defines.ENVMAP_TYPE_CUBE_UV).toBeUndefined();
  expect(material.uniforms.envMap.value).toBeNull();
});

test("the inner screen's crease band is the model's 6 mm bend band around the hinge line, in u", () => {
  const band = model.creaseBand();
  const activeWidthMm = 135.8;
  expect(band.centreU).toBeGreaterThan(0.45);
  expect(band.centreU).toBeLessThan(0.55);
  expect(band.halfWidthU).toBeCloseTo(3 / activeWidthMm, 2);
});

test("ScreenMaterial's crease follows the view blend on a screen with a band, and is off on one without", () => {
  const cover = new ScreenMaterial(model.cover.extras);
  cover.setCrease(1);
  expect(cover.uniforms.crease.value).toBe(0);

  const inner = new ScreenMaterial(model.inner.extras);
  inner.setCreaseBand(model.creaseBand());
  expect(inner.uniforms.creaseCentreU.value).toBe(model.creaseBand().centreU);
  inner.setCrease(0);
  expect(inner.uniforms.crease.value).toBe(0);
  inner.setCrease(0.5);
  expect(inner.uniforms.crease.value).toBeCloseTo(0.5 * CREASE_STRENGTH, 12);
});

test("a colourway restyles the frame and back materials by name, leaving the screens alone", async () => {
  const bytes = readFileSync(resolve("src/renderer/public/fold7.glb"));
  const fresh = await FoldModel.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  fresh.applyColourway({ frame: { baseColor: "#b8b6b2", metallic: 1, roughness: 0.35 }, back_glass: { baseColor: "#c8c6c2", metallic: 0, roughness: 0.45 } });
  const byName = new Map<string, THREE.MeshStandardMaterial>();
  fresh.root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && !Array.isArray(mesh.material)) byName.set(mesh.material.name, mesh.material as THREE.MeshStandardMaterial);
  });
  expect(byName.get("frame")!.color.getHexString(THREE.SRGBColorSpace)).toBe("b8b6b2");
  expect(byName.get("back_glass")!.metalness).toBe(0);
  expect(byName.get("hinge_spine")!.color.getHexString(THREE.SRGBColorSpace)).toBe("141414");
  expect(byName.get("screen_cover")!.color.getHex()).toBe(0);
});

test("the screens' active areas are the size and shape of the real panels", () => {
  const cover = model.screenSizeMm("cover");
  const inner = model.screenSizeMm("inner");
  expect(cover.h).toBeGreaterThan(148);
  expect(cover.h).toBeLessThan(158);
  expect(inner.w).toBeGreaterThan(130);
  expect(inner.w).toBeLessThan(146);
  expect(cover.h / cover.w).toBeCloseTo(2520 / 1080, 2);
  expect(inner.h / inner.w).toBeCloseTo(2184 / 1968, 2);
});
