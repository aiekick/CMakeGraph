// ------------------------------------------------------------
// 4x4 matrix utilities for WebGL (column-major Float32Array).
// Provides perspective projection, turntable view, and helpers
// for projecting world points to screen coordinates.
// ------------------------------------------------------------

export type Mat4 = Float32Array; // 16 elements, column-major

/** Identity 4x4 matrix. */
export function mat4Identity(): Mat4 {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
}

/** Standard OpenGL perspective projection matrix. */
export function mat4Perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
    const f = 1 / Math.tan(fovY / 2);
    const nf = 1 / (near - far);
    const m = new Float32Array(16);
    m[0] = f / aspect;
    m[5] = f;
    m[10] = (far + near) * nf;
    m[11] = -1;
    m[14] = 2 * far * near * nf;
    return m;
}

/** Build a turntable view matrix.
 *  Positive pitch = camera above XZ floor, looking down.
 *  V = translate(0,0,-dist) * Rx(pitch) * Ry(yaw) * translate(-target) */
export function mat4TurntableView(
    yaw: number, pitch: number, distance: number,
    tx: number, ty: number, tz: number,
): Mat4 {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);

    // Rx(pitch) * Ry(yaw)  (row-major):
    //   row0 = [ cy,        0,    sy     ]
    //   row1 = [ sp*sy,     cp,  -sp*cy  ]
    //   row2 = [-cp*sy,     sp,   cp*cy  ]
    // Translation part: R * (-target) + (0,0,-dist)
    const r00 = cy, r01 = 0, r02 = sy;
    const r10 = sp * sy, r11 = cp, r12 = -sp * cy;
    const r20 = -cp * sy, r21 = sp, r22 = cp * cy;

    const ex = -(r00 * tx + r01 * ty + r02 * tz);
    const ey = -(r10 * tx + r11 * ty + r12 * tz);
    const ez = -(r20 * tx + r21 * ty + r22 * tz) - distance;

    // Column-major layout
    const m = new Float32Array(16);
    m[0] = r00; m[1] = r10; m[2] = r20; m[3] = 0;
    m[4] = r01; m[5] = r11; m[6] = r21; m[7] = 0;
    m[8] = r02; m[9] = r12; m[10] = r22; m[11] = 0;
    m[12] = ex; m[13] = ey; m[14] = ez; m[15] = 1;
    return m;
}

/** Multiply two 4x4 column-major matrices: out = a * b. */
export function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
            o[c * 4 + r] =
                a[r] * b[c * 4] +
                a[4 + r] * b[c * 4 + 1] +
                a[8 + r] * b[c * 4 + 2] +
                a[12 + r] * b[c * 4 + 3];
        }
    }
    return o;
}

/** Invert a 4x4 column-major matrix. Returns identity if singular. */
export function mat4Invert(m: Mat4): Mat4 {
    const inv = new Float32Array(16);
    const m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3];
    const m4 = m[4], m5 = m[5], m6 = m[6], m7 = m[7];
    const m8 = m[8], m9 = m[9], m10 = m[10], m11 = m[11];
    const m12 = m[12], m13 = m[13], m14 = m[14], m15 = m[15];

    const t0 = m10 * m15 - m14 * m11;
    const t1 = m9 * m15 - m13 * m11;
    const t2 = m9 * m14 - m13 * m10;
    const t3 = m8 * m15 - m12 * m11;
    const t4 = m8 * m14 - m12 * m10;
    const t5 = m8 * m13 - m12 * m9;

    inv[0] = m5 * t0 - m6 * t1 + m7 * t2;
    inv[4] = -(m4 * t0 - m6 * t3 + m7 * t4);
    inv[8] = m4 * t1 - m5 * t3 + m7 * t5;
    inv[12] = -(m4 * t2 - m5 * t4 + m6 * t5);

    const t6 = m2 * m15 - m14 * m3;
    const t7 = m1 * m15 - m13 * m3;
    const t8 = m1 * m14 - m13 * m2;
    const t9 = m0 * m15 - m12 * m3;
    const t10 = m0 * m14 - m12 * m2;
    const t11 = m0 * m13 - m12 * m1;

    inv[1] = -(m1 * t0 - m2 * t1 + m3 * t2);
    inv[5] = m0 * t0 - m2 * t3 + m3 * t4;
    inv[9] = -(m0 * t1 - m1 * t3 + m3 * t5);
    inv[13] = m0 * t2 - m1 * t4 + m2 * t5;

    inv[2] = m5 * t6 - m6 * t7 + m7 * t8;
    inv[6] = -(m4 * t6 - m6 * t9 + m7 * t10);
    inv[10] = m4 * t7 - m5 * t9 + m7 * t11;
    inv[14] = -(m4 * t8 - m5 * t10 + m6 * t11);

    const t12 = m2 * m7 - m6 * m3;
    const t13 = m1 * m7 - m5 * m3;
    const t14 = m1 * m6 - m5 * m2;
    const t15 = m0 * m7 - m4 * m3;
    const t16 = m0 * m6 - m4 * m2;
    const t17 = m0 * m5 - m4 * m1;

    inv[3] = -(m9 * t12 - m10 * t13 + m11 * t14);
    inv[7] = m8 * t12 - m10 * t15 + m11 * t16;
    inv[11] = -(m8 * t13 - m9 * t15 + m11 * t17);
    inv[15] = m8 * t14 - m9 * t16 + m10 * t17;

    let det = m0 * inv[0] + m1 * inv[4] + m2 * inv[8] + m3 * inv[12];
    if (Math.abs(det) < 1e-10) { return mat4Identity(); }
    det = 1 / det;
    for (let i = 0; i < 16; i++) { inv[i] *= det; }
    return inv;
}

/** Project a world point to screen coordinates using the VP matrix.
 *  Returns [screenX, screenY, ndcZ] where screenX/Y are in CSS pixels. */
export function mat4ProjectPoint(
    vp: Mat4, wx: number, wy: number, wz: number,
    vpW: number, vpH: number,
): [number, number, number] {
    const x = vp[0] * wx + vp[4] * wy + vp[8] * wz + vp[12];
    const y = vp[1] * wx + vp[5] * wy + vp[9] * wz + vp[13];
    const z = vp[2] * wx + vp[6] * wy + vp[10] * wz + vp[14];
    const w = vp[3] * wx + vp[7] * wy + vp[11] * wz + vp[15];
    if (Math.abs(w) < 1e-10) { return [0, 0, -1]; }
    const invW = 1 / w;
    const ndcX = x * invW;
    const ndcY = y * invW;
    const ndcZ = z * invW;
    return [
        (ndcX * 0.5 + 0.5) * vpW,
        (1 - (ndcY * 0.5 + 0.5)) * vpH, // flip Y: NDC +Y up → screen +Y down
        ndcZ,
    ];
}

/** Unproject screen coordinates to world space at a given NDC depth.
 *  Used for node dragging. */
export function mat4UnprojectPoint(
    invVP: Mat4, sx: number, sy: number, ndcZ: number,
    vpW: number, vpH: number,
): [number, number, number] {
    const ndcX = (sx / vpW) * 2 - 1;
    const ndcY = 1 - (sy / vpH) * 2;
    const x = invVP[0] * ndcX + invVP[4] * ndcY + invVP[8] * ndcZ + invVP[12];
    const y = invVP[1] * ndcX + invVP[5] * ndcY + invVP[9] * ndcZ + invVP[13];
    const z = invVP[2] * ndcX + invVP[6] * ndcY + invVP[10] * ndcZ + invVP[14];
    const w = invVP[3] * ndcX + invVP[7] * ndcY + invVP[11] * ndcZ + invVP[15];
    if (Math.abs(w) < 1e-10) { return [0, 0, 0]; }
    const invW = 1 / w;
    return [x * invW, y * invW, z * invW];
}

/** Compute camera world position from turntable parameters.
 *  CamPos = target + R^T * (0,0,dist) where R = Rx(pitch)*Ry(yaw). */
export function turntableCameraPos(
    yaw: number, pitch: number, distance: number,
    tx: number, ty: number, tz: number,
): [number, number, number] {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    // R^T * (0,0,d) = (r20*d, r21*d, r22*d) = (-cp*sy*d, sp*d, cp*cy*d)
    return [
        tx - distance * cp * sy,
        ty + distance * sp,
        tz + distance * cp * cy,
    ];
}
