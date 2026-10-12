// ------------------------------------------------------------
// WebGL shader sources and compile/link helpers.
// All GLSL is inlined as template literals (CSP-safe).
// ------------------------------------------------------------

// ============================================================
// Grid shader — procedural infinite floor grid via ray-plane intersection.
// One fullscreen quad, one draw call.
// ============================================================

export const GRID_VERT = `
attribute vec2 a_position;
varying vec2 v_ndc;
void main() {
    v_ndc = a_position;
    gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

export const GRID_FRAG = `
#extension GL_OES_standard_derivatives : enable
precision highp float;

uniform mat4 u_invVP;
uniform mat4 u_VP;
uniform vec3 u_cameraPos;
uniform vec2 u_resolution;
uniform float u_gridStep;
uniform float u_majorStep;
uniform float u_camDistance;
uniform vec4 u_lineColor;

varying vec2 v_ndc;

void main() {
    // Reconstruct world-space ray
    vec4 nearW = u_invVP * vec4(v_ndc, -1.0, 1.0);
    vec4 farW  = u_invVP * vec4(v_ndc,  1.0, 1.0);
    vec3 ro = nearW.xyz / nearW.w;
    vec3 rd = normalize(farW.xyz / farW.w - ro);

    vec3 outColor = vec3(0.0);
    float outAlpha = 0.0;

    // --- Floor grid (y=0 plane) with colored X/Z axes ---
    if (abs(rd.y) > 1e-6) {
        float t = -ro.y / rd.y;
        if (t > 0.0) {
            vec3 hit = ro + rd * t;
            float dist = length(hit - u_cameraPos);
            float fadeStart = u_camDistance * 0.4;
            float fadeEnd   = u_camDistance * 2.5;
            float fade = 1.0 - smoothstep(fadeStart, fadeEnd, dist);

            if (fade > 0.001) {
                float lx = abs(mod(hit.x + u_gridStep * 0.5, u_gridStep) - u_gridStep * 0.5);
                float lz = abs(mod(hit.z + u_gridStep * 0.5, u_gridStep) - u_gridStep * 0.5);
                float dxw = length(vec2(dFdx(hit.x), dFdy(hit.x)));
                float dzw = length(vec2(dFdx(hit.z), dFdy(hit.z)));
                float lineW = 1.5;

                // Minor grid
                float gx = 1.0 - smoothstep(0.0, lineW * dxw, lx);
                float gz = 1.0 - smoothstep(0.0, lineW * dzw, lz);
                float minorA = max(gx, gz) * u_lineColor.a * 0.4 * fade;

                // Major grid
                float mlx = abs(mod(hit.x + u_majorStep * 0.5, u_majorStep) - u_majorStep * 0.5);
                float mlz = abs(mod(hit.z + u_majorStep * 0.5, u_majorStep) - u_majorStep * 0.5);
                float mgx = 1.0 - smoothstep(0.0, lineW * 1.5 * dxw, mlx);
                float mgz = 1.0 - smoothstep(0.0, lineW * 1.5 * dzw, mlz);
                float majorA = max(mgx, mgz) * u_lineColor.a * 0.8 * fade;

                // X axis (z=0 line, x>=0 only) -> red
                float xAxisA = (1.0 - smoothstep(0.0, lineW * 2.0 * dzw, abs(hit.z))) * step(0.0, hit.x) * 0.9 * fade;
                // Z axis (x=0 line, z>=0 only) -> blue
                float zAxisA = (1.0 - smoothstep(0.0, lineW * 2.0 * dxw, abs(hit.x))) * step(0.0, hit.z) * 0.9 * fade;

                // Highest-alpha layer wins
                outColor = u_lineColor.rgb; outAlpha = minorA;
                if (majorA > outAlpha) { outAlpha = majorA; }
                if (xAxisA > outAlpha) { outColor = vec3(0.88, 0.31, 0.31); outAlpha = xAxisA; }
                if (zAxisA > outAlpha) { outColor = vec3(0.31, 0.50, 0.88); outAlpha = zAxisA; }
            }
        }
    }

    // --- Y axis (screen-space projected line from origin upward) -> green ---
    vec4 yBaseClip = u_VP * vec4(0.0, 0.0, 0.0, 1.0);
    vec4 yTipClip  = u_VP * vec4(0.0, u_camDistance, 0.0, 1.0);
    if (yBaseClip.w > 0.01 && yTipClip.w > 0.01) {
        vec2 yBaseScreen = (yBaseClip.xy / yBaseClip.w) * u_resolution * 0.5;
        vec2 yTipScreen  = (yTipClip.xy / yTipClip.w) * u_resolution * 0.5;
        vec2 pixScreen   = v_ndc * u_resolution * 0.5;
        vec2 yDir = yTipScreen - yBaseScreen;
        float yDirLen = length(yDir);
        if (yDirLen > 1.0) {
            vec2 yDirN = yDir / yDirLen;
            float proj = dot(pixScreen - yBaseScreen, yDirN);
            float tLine = proj / yDirLen;
            if (tLine > 0.0 && tLine < 1.0) {
                vec2 yPerp = vec2(-yDirN.y, yDirN.x);
                float yPixDist = abs(dot(pixScreen - yBaseScreen, yPerp));
                float yLine = 1.0 - smoothstep(0.0, 1.5, yPixDist);
                float yFade = 1.0 - smoothstep(0.7, 1.0, max(tLine, 0.0));
                float yA = yLine * yFade * 0.9;
                if (yA > outAlpha) { outColor = vec3(0.31, 0.69, 0.31); outAlpha = yA; }
            }
        }
    }

    if (outAlpha < 0.001) { discard; }
    gl_FragColor = vec4(outColor, outAlpha);
}
`;

// ============================================================
// Edge shader — screen-space expanded quads for graph edges.
// ============================================================

export const EDGE_VERT = `
attribute vec3 a_from;
attribute vec3 a_to;
attribute vec2 a_corner;      // x: 0=from, 1=to; y: -1 or +1 (perpendicular side)
attribute vec4 a_color;
attribute float a_widthFrom;
attribute float a_widthTo;

uniform mat4 u_VP;
uniform vec2 u_resolution;

varying vec4 v_color;
varying vec2 v_edgeCoord;     // x: 0..1 along edge, y: -1..+1 across

void main() {
    // Project both endpoints
    vec4 clipFrom = u_VP * vec4(a_from, 1.0);
    vec4 clipTo   = u_VP * vec4(a_to, 1.0);

    // NDC positions
    vec2 ndcFrom = clipFrom.xy / clipFrom.w;
    vec2 ndcTo   = clipTo.xy / clipTo.w;

    // Screen-space direction and perpendicular
    vec2 screenFrom = ndcFrom * u_resolution * 0.5;
    vec2 screenTo   = ndcTo * u_resolution * 0.5;
    vec2 dir = screenTo - screenFrom;
    float len = length(dir);
    vec2 perp = len > 0.001 ? vec2(-dir.y, dir.x) / len : vec2(0.0, 1.0);

    // Interpolate position and width along edge
    float t = a_corner.x;
    vec4 clip = mix(clipFrom, clipTo, t);
    float w = mix(a_widthFrom, a_widthTo, t) * 0.5;

    // Offset in screen-space perpendicular direction
    vec2 offset = perp * a_corner.y * w;
    // Convert pixel offset to NDC
    vec2 ndcOffset = offset / (u_resolution * 0.5);

    gl_Position = vec4(clip.xy / clip.w + ndcOffset, clip.z / clip.w, 1.0);

    v_color = a_color;
    v_edgeCoord = vec2(t, a_corner.y);
}
`;

export const EDGE_FRAG = `
precision mediump float;
varying vec4 v_color;
varying vec2 v_edgeCoord;

void main() {
    // Soft edge (anti-alias perpendicular edges)
    float aa = 1.0 - smoothstep(0.7, 1.0, abs(v_edgeCoord.y));
    gl_FragColor = vec4(v_color.rgb, v_color.a * aa);
}
`;

// ============================================================
// Compile / link helpers
// ============================================================

function compileShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const info = gl.getShaderInfoLog(s);
        gl.deleteShader(s);
        throw new Error(`Shader compile error: ${info}`);
    }
    return s;
}

/** Create and link a WebGL program from vertex + fragment shader sources. */
export function createProgram(gl: WebGLRenderingContext, vertSrc: string, fragSrc: string): WebGLProgram {
    const vs = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
    const p = gl.createProgram()!;
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        const info = gl.getProgramInfoLog(p);
        gl.deleteProgram(p);
        throw new Error(`Program link error: ${info}`);
    }
    // Shaders can be detached after linking
    gl.detachShader(p, vs);
    gl.detachShader(p, fs);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return p;
}
