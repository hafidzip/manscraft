import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

const material = new THREE.ShaderMaterial({
  uniforms: {
    tDiffuse: { value: null },
    exposure: { value: 1 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float exposure;
    varying vec2 vUv;

    // ACES Filmic (Narkowicz) — matches THREE.ACESFilmicToneMapping
    vec3 ACESFilm(vec3 x) {
      float a = 2.51;
      float b = 0.03;
      float c = 2.43;
      float d = 0.59;
      float e = 0.14;
      return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
    }

    vec3 linearToSRGB(vec3 c) {
      vec3 low = c * 12.92;
      vec3 high = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
      return mix(high, low, lessThanEqual(c, vec3(0.0031308)));
    }

    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      color.rgb *= exposure;
      color.rgb = ACESFilm(color.rgb);
      // small warm lift to keep golden hour from going cold after ACES desat
      // color.rgb = pow(color.rgb, vec3(0.96, 0.98, 1.02));
      gl_FragColor = vec4(linearToSRGB(color.rgb), color.a);
    }
  `,
  depthTest: false,
  depthWrite: false,
  toneMapped: false,
});

export class OutputStage {
  private quad = new FullScreenQuad(material.clone());

  render(renderer: THREE.WebGLRenderer, input: THREE.Texture): void {
    const shader = this.quad.material as THREE.ShaderMaterial;
    shader.uniforms.tDiffuse.value = input;
    shader.uniforms.exposure.value = renderer.toneMappingExposure;
    renderer.setRenderTarget(null);
    this.quad.render(renderer);
  }

  dispose(): void {
    this.quad.material.dispose();
    this.quad.dispose();
  }
}

material.dispose();
