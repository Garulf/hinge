import * as THREE from "three";
import { streamSampleMatrix, type Rotation } from "../../shared/screen-uv";
import type { ScreenExtras } from "./fold-model";

const vertexShader = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
varying vec2 vUv;
void main() {
  vUv = uv;
  #include <skinbase_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
}
`;

const fragmentShader = /* glsl */ `
uniform sampler2D map;
uniform bool hasMap;
uniform mat3 sampleMatrix;
uniform float brightness;
uniform vec2 pixelSize;
uniform float cornerRadiusPx;
uniform vec3 punchHolePx;
varying vec2 vUv;

float roundedRectDistance(vec2 p, vec2 halfSize, float radius) {
  vec2 q = abs(p) - halfSize + radius;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
}

float coverage(float distance) {
  float width = max(fwidth(distance), 1e-4);
  return 1.0 - smoothstep(-0.5 * width, 0.5 * width, distance);
}

void main() {
  vec2 px = vUv * pixelSize;
  float inside = coverage(roundedRectDistance(px - 0.5 * pixelSize, 0.5 * pixelSize, cornerRadiusPx));
  vec3 color = vec3(0.0);
  if (hasMap) {
    vec2 st = (sampleMatrix * vec3(vUv, 1.0)).xy;
    color = sRGBTransferEOTF(texture2D(map, st)).rgb;
  }
  color *= brightness;
  float hole = coverage(length(px - punchHolePx.xy) - punchHolePx.z);
  gl_FragColor = vec4(mix(color, vec3(0.0), hole), inside);
  #include <colorspace_fragment>
}
`;

/**
 * Samples a VideoFrameTexture (sRGB, decoded by hand since three only
 * decodes video textures for its built-in materials) through the stream's
 * rotation transform, masked to the screen's rounded corners and punch hole.
 */
export class ScreenMaterial extends THREE.ShaderMaterial {
  constructor(extras: ScreenExtras) {
    const [w, h] = extras.pixelSize;
    const [ru, rv] = extras.cornerRadiusUv;
    const [holeU, holeV, holeRadiusU] = extras.punchHole;
    super({
      vertexShader,
      fragmentShader,
      transparent: true,
      toneMapped: false,
      uniforms: {
        map: { value: null },
        hasMap: { value: false },
        sampleMatrix: { value: new THREE.Matrix3().fromArray(streamSampleMatrix(0)) },
        brightness: { value: 0 },
        pixelSize: { value: new THREE.Vector2(w, h) },
        cornerRadiusPx: { value: (ru * w + rv * h) / 2 },
        punchHolePx: { value: new THREE.Vector3(holeU * w, holeV * h, holeRadiusU * w) },
      },
    });
  }

  setVideo(texture: THREE.Texture | null): void {
    this.uniforms.map.value = texture;
    this.uniforms.hasMap.value = texture !== null;
  }

  video(): THREE.Texture | null {
    return this.uniforms.map.value as THREE.Texture | null;
  }

  setRotation(rotation: Rotation): void {
    (this.uniforms.sampleMatrix.value as THREE.Matrix3).fromArray(streamSampleMatrix(rotation));
  }

  setBrightness(b: number): void {
    this.uniforms.brightness.value = b;
  }
}
