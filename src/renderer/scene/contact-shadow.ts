import * as THREE from "three";
import { HorizontalBlurShader } from "three/examples/jsm/shaders/HorizontalBlurShader.js";
import { VerticalBlurShader } from "three/examples/jsm/shaders/VerticalBlurShader.js";

function blurMaterial(shader: { uniforms: Record<string, THREE.IUniform>; vertexShader: string; fragmentShader: string }): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.clone(shader.uniforms),
    vertexShader: shader.vertexShader,
    fragmentShader: shader.fragmentShader,
    depthTest: false,
  });
}

export interface ContactShadowOptions {
  /** Side of the square ground patch the shadow covers, in metres. */
  size: number;
  /** Height above the ground that still casts, in metres. */
  height: number;
  resolution: number;
  /** Blur radius in texels of a 256 texel map. */
  blur: number;
  /**
   * Gain on the depth pass's alpha. An upright phone's footprint is only a
   * few millimetres deep, so the blur thins it out; with a half-float map
   * the gain survives the blur and is capped at 1 only when drawn.
   */
  darkness: number;
  opacity: number;
}

const planeVertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const planeFragmentShader = /* glsl */ `
uniform sampler2D map;
uniform float opacity;
varying vec2 vUv;
void main() {
  gl_FragColor = vec4(vec3(0.0), min(texture2D(map, vUv).a, 1.0) * opacity);
}
`;

function canRenderHalfFloat(renderer: THREE.WebGLRenderer): boolean {
  return renderer.extensions.has("EXT_color_buffer_float") || renderer.extensions.has("EXT_color_buffer_half_float");
}

/**
 * A soft shadow on an invisible ground plane, after three's contact shadows
 * example: the model is drawn from the ground looking up with a depth
 * material whose alpha fades with height, then blurred twice.
 */
export class ContactShadow {
  readonly group = new THREE.Group();
  readonly #renderer: THREE.WebGLRenderer;
  readonly #options: ContactShadowOptions;
  readonly #target: THREE.WebGLRenderTarget;
  readonly #blurTarget: THREE.WebGLRenderTarget;
  readonly #camera: THREE.OrthographicCamera;
  readonly #plane: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  readonly #blurPlane: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  readonly #depthMaterial: THREE.MeshDepthMaterial;
  readonly #horizontalBlur = blurMaterial(HorizontalBlurShader);
  readonly #verticalBlur = blurMaterial(VerticalBlurShader);

  constructor(renderer: THREE.WebGLRenderer, options: ContactShadowOptions) {
    this.#renderer = renderer;
    this.#options = options;
    const { size, height, resolution } = options;
    const type = canRenderHalfFloat(renderer) ? THREE.HalfFloatType : THREE.UnsignedByteType;
    this.#target = new THREE.WebGLRenderTarget(resolution, resolution, { type, generateMipmaps: false, depthBuffer: false });
    this.#blurTarget = new THREE.WebGLRenderTarget(resolution, resolution, { type, generateMipmaps: false, depthBuffer: false });

    const geometry = new THREE.PlaneGeometry(size, size).rotateX(Math.PI / 2);
    this.#plane = new THREE.Mesh(
      geometry,
      new THREE.ShaderMaterial({
        uniforms: { map: { value: this.#target.texture }, opacity: { value: 0 } },
        vertexShader: planeVertexShader,
        fragmentShader: planeFragmentShader,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    this.#plane.scale.y = -1;
    this.#plane.renderOrder = 1;
    this.#plane.visible = false;
    this.group.add(this.#plane);

    this.#blurPlane = new THREE.Mesh(geometry, this.#horizontalBlur);
    this.#blurPlane.visible = false;
    this.group.add(this.#blurPlane);

    this.#camera = new THREE.OrthographicCamera(-size / 2, size / 2, size / 2, -size / 2, 0, height);
    this.#camera.rotation.x = Math.PI / 2;
    this.group.add(this.#camera);

    const darkness = { value: options.darkness };
    this.#depthMaterial = new THREE.MeshDepthMaterial({ depthTest: false, depthWrite: false });
    this.#depthMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.darkness = darkness;
      shader.fragmentShader = `uniform float darkness;\n${shader.fragmentShader.replace(
        "gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );",
        "gl_FragColor = vec4( vec3( 0.0 ), ( 1.0 - fragCoordZ ) * darkness );",
      )}`;
    };
  }

  /** Puts the patch's centre on the ground under the model. */
  place(x: number, groundY: number, z: number): void {
    this.group.position.set(x, groundY, z);
  }

  /** `strength` 0 hides the shadow; 1 shows it at full opacity. */
  setStrength(strength: number): void {
    this.#plane.material.uniforms.opacity.value = this.#options.opacity * strength;
    this.#plane.visible = strength > 0;
  }

  /** Redraws the shadow map from `scene` (with `hidden` left out); needed only when the model's pose or placement changed. */
  capture(scene: THREE.Scene, hidden: THREE.Object3D[]): void {
    const renderer = this.#renderer;
    const restore = [this.#plane, ...hidden].map((o) => [o, o.visible] as const);
    for (const [o] of restore) o.visible = false;
    const previousTarget = renderer.getRenderTarget();

    scene.updateMatrixWorld();
    scene.overrideMaterial = this.#depthMaterial;
    renderer.setRenderTarget(this.#target);
    renderer.clear();
    renderer.render(scene, this.#camera);
    scene.overrideMaterial = null;
    for (const [o, visible] of restore) o.visible = visible;

    this.#blur(this.#options.blur);
    this.#blur(this.#options.blur * 0.4);
    renderer.setRenderTarget(previousTarget);
  }

  dispose(): void {
    this.#target.dispose();
    this.#blurTarget.dispose();
    this.#plane.geometry.dispose();
    this.#plane.material.dispose();
    this.#depthMaterial.dispose();
    this.#horizontalBlur.dispose();
    this.#verticalBlur.dispose();
  }

  #blur(amount: number): void {
    const renderer = this.#renderer;
    this.#blurPlane.visible = true;

    this.#blurPlane.material = this.#horizontalBlur;
    this.#horizontalBlur.uniforms.tDiffuse.value = this.#target.texture;
    this.#horizontalBlur.uniforms.h.value = amount / 256;
    renderer.setRenderTarget(this.#blurTarget);
    renderer.clear();
    renderer.render(this.#blurPlane, this.#camera);

    this.#blurPlane.material = this.#verticalBlur;
    this.#verticalBlur.uniforms.tDiffuse.value = this.#blurTarget.texture;
    this.#verticalBlur.uniforms.v.value = amount / 256;
    renderer.setRenderTarget(this.#target);
    renderer.clear();
    renderer.render(this.#blurPlane, this.#camera);

    this.#blurPlane.visible = false;
  }
}
