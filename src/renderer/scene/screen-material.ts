import * as THREE from "three";
import { streamSampleMatrix, type Rotation } from "../../shared/screen-uv";
import type { ScreenExtras } from "./fold-model";

const vertexShader = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
varying vec2 vUv;
varying vec3 vViewNormal;
varying vec3 vViewPosition;
void main() {
  vUv = uv;
  #include <beginnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>
  vViewNormal = transformedNormal;
  #include <begin_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
  vViewPosition = -mvPosition.xyz;
}
`;

/**
 * Scales the environment the screens reflect (not the body's), so a black
 * pixel at the showcase rest angle stays near black while grazing views
 * still catch the room.
 */
const SCREEN_REFLECTION = 0.24;

/** Overall strength of the inner screen's crease in the showcase; its parts are tuned relative to it. */
export const CREASE_STRENGTH = 1;
/** How far the valley tilts the normal at the band's steepest point. */
const CREASE_TILT = 0.5;
/** Video shift across the band per unit of along-u view direction, in band half-widths. */
const CREASE_WARP = 0.6;
/** Extra reflection along the band's middle, on top of the glass. */
const CREASE_SHEEN = 5;
/** Off-axis view angle, in degrees, below which the crease is invisible, as it is on the real phone seen head on. */
const CREASE_ONSET_DEG = 40;
/** Off-axis view angle, in degrees, at which the crease reaches full strength. */
const CREASE_FULL_DEG = 75;

const fragmentShader = /* glsl */ `
#include <common>
#include <cube_uv_reflection_fragment>
uniform sampler2D map;
uniform bool hasMap;
uniform mat3 sampleMatrix;
uniform float brightness;
uniform vec2 pixelSize;
uniform float cornerRadiusPx;
uniform vec3 punchHolePx;
uniform float glass;
uniform float crease;
uniform float creaseCentreU;
uniform float creaseHalfWidthU;
uniform sampler2D envMap;
varying vec2 vUv;
varying vec3 vViewNormal;
varying vec3 vViewPosition;

const float GLASS_F0 = 0.04;
const float GLASS_F90 = 0.5;
const float SCREEN_REFLECTION = ${SCREEN_REFLECTION.toFixed(4)};
const float CREASE_TILT = ${CREASE_TILT.toFixed(4)};
const float CREASE_WARP = ${CREASE_WARP.toFixed(4)};
const float CREASE_SHEEN = ${CREASE_SHEEN.toFixed(4)};
const float CREASE_ONSET_COS = ${Math.cos((CREASE_ONSET_DEG * Math.PI) / 180).toFixed(4)};
const float CREASE_FULL_COS = ${Math.cos((CREASE_FULL_DEG * Math.PI) / 180).toFixed(4)};

vec3 environmentRadiance(vec3 worldDirection) {
#ifdef ENVMAP_TYPE_CUBE_UV
  return textureCubeUV(envMap, worldDirection, 0.0).rgb;
#else
  float up = worldDirection.y * 0.5 + 0.5;
  return mix(vec3(0.03), vec3(1.2), smoothstep(0.55, 0.95, up));
#endif
}

vec3 glassReflection(vec3 viewNormal, vec3 viewDirection) {
  float cosTheta = clamp(dot(viewNormal, viewDirection), 0.0, 1.0);
  float fresnel = GLASS_F0 + (GLASS_F90 - GLASS_F0) * pow(1.0 - cosTheta, 5.0);
  vec3 reflected = inverseTransformDirection(reflect(-viewDirection, viewNormal), viewMatrix);
  return fresnel * SCREEN_REFLECTION * environmentRadiance(reflected);
}

vec3 screenTangent(vec3 normal) {
  vec3 position = -vViewPosition;
  vec3 dpx = dFdx(position);
  vec3 dpy = dFdy(position);
  vec2 dux = dFdx(vUv);
  vec2 duy = dFdy(vUv);
  vec3 tangent = (dpx * duy.y - dpy * dux.y) * sign(dux.x * duy.y - duy.x * dux.y);
  tangent -= normal * dot(normal, tangent);
  return normalize(tangent);
}

float creaseVisibility(vec3 normal, vec3 viewDirection) {
  float cosTheta = clamp(dot(normal, viewDirection), 0.0, 1.0);
  return 1.0 - smoothstep(CREASE_FULL_COS, CREASE_ONSET_COS, cosTheta);
}

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
  vec3 viewDirection = isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(vViewPosition);
  vec3 normal = normalize(vViewNormal);
  vec2 sampleUv = vUv;
  float band = 0.0;
  float creaseStrength = 0.0;
  if (crease > 0.0) {
    vec3 tangent = screenTangent(normal);
    creaseStrength = crease * creaseVisibility(normal, viewDirection);
    float d = clamp((vUv.x - creaseCentreU) / creaseHalfWidthU, -1.0, 1.0);
    float across = 1.0 - d * d;
    band = across * across;
    normal = normalize(normal - creaseStrength * CREASE_TILT * 4.0 * d * across * tangent);
    sampleUv.x += creaseStrength * CREASE_WARP * creaseHalfWidthU * band * dot(viewDirection, tangent);
  }
  vec3 color = vec3(0.0);
  if (hasMap) {
    vec2 st = (sampleMatrix * vec3(sampleUv, 1.0)).xy;
    color = texture2D(map, st).rgb;
  }
  color *= brightness;
  float hole = coverage(length(px - punchHolePx.xy) - punchHolePx.z);
  color = mix(color, vec3(0.0), hole);
  float reflection = glass + creaseStrength * CREASE_SHEEN * band;
  if (reflection > 0.0) {
    vec3 linear = sRGBTransferEOTF(vec4(color, 1.0)).rgb + reflection * glassReflection(normal, viewDirection);
    color = sRGBTransferOETF(vec4(linear, 1.0)).rgb;
  }
  gl_FragColor = vec4(color, inside);
}
`;

const CUBE_UV_DEFINE_KEYS = ["ENVMAP_TYPE_CUBE_UV", "CUBEUV_TEXEL_WIDTH", "CUBEUV_TEXEL_HEIGHT", "CUBEUV_MAX_MIP"] as const;

/** three's layout constants for a PMREM (cube UV) texture of this height, as it defines them for its own materials. */
function cubeUvDefines(imageHeight: number): Record<(typeof CUBE_UV_DEFINE_KEYS)[number], string> {
  const maxMip = Math.log2(imageHeight) - 2;
  return {
    ENVMAP_TYPE_CUBE_UV: "",
    CUBEUV_TEXEL_WIDTH: String(1 / (3 * Math.max(2 ** maxMip, 7 * 16))),
    CUBEUV_TEXEL_HEIGHT: String(1 / imageHeight),
    CUBEUV_MAX_MIP: `${maxMip}.0`,
  };
}

/**
 * Samples a VideoFrameTexture through the stream's rotation transform,
 * masked to the screen's rounded corners and punch hole. three uploads video
 * textures without sRGB decoding, so the samples are already in the output's
 * sRGB encoding and pass through unconverted (brightness fades in that
 * perceptual space); only the glass reflection, which is added in linear
 * light, converts them.
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
        glass: { value: 0 },
        crease: { value: 0 },
        creaseCentreU: { value: 0.5 },
        creaseHalfWidthU: { value: 0 },
        envMap: { value: null },
      },
    });
  }

  /** 0 in the work view; up to 1 for the full fresnel-weighted reflection. */
  setGlass(strength: number): void {
    this.uniforms.glass.value = strength;
  }

  /** The band a crease runs along, for the inner screen; without one the screen has no crease. */
  setCreaseBand(band: { centreU: number; halfWidthU: number }): void {
    this.uniforms.creaseCentreU.value = band.centreU;
    this.uniforms.creaseHalfWidthU.value = band.halfWidthU;
  }

  /** 0 in the work view, 1 in the showcase; always 0 without a crease band. */
  setCrease(t: number): void {
    this.uniforms.crease.value = this.uniforms.creaseHalfWidthU.value > 0 ? CREASE_STRENGTH * t : 0;
  }

  /** A PMREM environment to reflect, or null for a plain studio gradient. */
  setEnvironment(texture: THREE.Texture | null): void {
    this.uniforms.envMap.value = texture;
    for (const key of CUBE_UV_DEFINE_KEYS) delete this.defines[key];
    const image = texture?.image as { height?: number } | undefined;
    if (texture && texture.mapping === THREE.CubeUVReflectionMapping && image?.height) Object.assign(this.defines, cubeUvDefines(image.height));
    this.needsUpdate = true;
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
