// ------------------------------------------------------------
// 3D math utilities: quaternions, rotation matrices, projection.
// Pure functions, no dependencies beyond types.
// ------------------------------------------------------------

export type Quat = [number, number, number, number]; // [x, y, z, w]
export type Vec3 = [number, number, number];
export type Mat3 = number[]; // 9 elements, row-major

// ------------------------------------------------------------
// Quaternion operations
// ------------------------------------------------------------

export function quatMultiply(a: Quat, b: Quat): Quat {
    return [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ];
}

export function quatNormalize(q: Quat): Quat {
    const len = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
    if (len < 1e-10) { return [0, 0, 0, 1]; }
    return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

export function quatConjugate(q: Quat): Quat {
    return [-q[0], -q[1], -q[2], q[3]];
}

export function quatFromAxisAngle(ax: number, ay: number, az: number, angle: number): Quat {
    const half = angle / 2;
    const s = Math.sin(half);
    return [ax * s, ay * s, az * s, Math.cos(half)];
}

export const QUAT_IDENTITY: Quat = [0, 0, 0, 1];

// ------------------------------------------------------------
// Rotation matrix from quaternion
// ------------------------------------------------------------

/** Convert quaternion to 3x3 rotation matrix (row-major). */
export function quatToMatrix(q: Quat): Mat3 {
    const [x, y, z, w] = q;
    return [
        1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
        2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
        2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
    ];
}

/** Rotate a 3D point by a 3x3 rotation matrix. */
export function rotatePoint(m: Mat3, px: number, py: number, pz: number): Vec3 {
    return [
        m[0] * px + m[1] * py + m[2] * pz,
        m[3] * px + m[4] * py + m[5] * pz,
        m[6] * px + m[7] * py + m[8] * pz,
    ];
}

// ------------------------------------------------------------
// Turntable camera helper
// ------------------------------------------------------------

/** Build a rotation matrix for a turntable camera.
 *  yaw = horizontal rotation around Y axis (radians).
 *  pitch = vertical tilt angle (radians), clamped to avoid gimbal lock.
 *  Positive pitch = camera above the XZ floor plane, looking down.
 *  Result = Rx(pitch) * Ry(yaw) in row-major order.
 *  The Y world axis always projects vertically on screen (x component = 0). */
export function turntableMatrix(yaw: number, pitch: number): Mat3 {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    // Rx(pitch) * Ry(yaw):
    //   row0 = [ cy,        0,    sy      ]
    //   row1 = [ sp*sy,     cp,  -sp*cy   ]
    //   row2 = [-cp*sy,     sp,   cp*cy   ]
    return [
         cy,        0,        sy,
         sp * sy,   cp,      -sp * cy,
        -cp * sy,   sp,       cp * cy,
    ];
}

// ------------------------------------------------------------
// Arcball helper (kept for compatibility)
// ------------------------------------------------------------

/** Map screen coordinates to a point on the arcball sphere (unit sphere).
 *  Returns [x, y, z] where z >= 0 for points inside the sphere. */
export function arcballVector(sx: number, sy: number, cw: number, ch: number): Vec3 {
    const dim = Math.min(cw, ch);
    const x = (2 * sx - cw) / dim;
    const y = (ch - 2 * sy) / dim;
    const len_sq = x * x + y * y;
    if (len_sq <= 1) {
        return [x, y, Math.sqrt(1 - len_sq)];
    }
    const len = Math.sqrt(len_sq);
    return [x / len, y / len, 0];
}

// ------------------------------------------------------------
// 3D Projection
// ------------------------------------------------------------

/** Project a 3D world point to screen coordinates using perspective projection.
 *  Camera is at (0, 0, -camDistance) looking toward origin.
 *  Returns [screenX, screenY, cameraSpaceZ] where cameraSpaceZ is used for depth sorting. */
export function projectToScreen(
    wx: number, wy: number, wz: number,
    rotMatrix: Mat3,
    camDistance: number,
    focalLength: number,
    canvasCx: number,
    canvasCy: number,
): Vec3 {
    // Apply rotation
    const [rx, ry, rz] = rotatePoint(rotMatrix, wx, wy, wz);
    // Translate: camera at (0, 0, -camDistance), so camera-space z = rz + camDistance
    const cz = rz + camDistance;
    // Perspective division
    const scale = focalLength / Math.max(cz, 1);
    return [
        canvasCx + rx * scale,
        canvasCy - ry * scale, // flip Y (screen Y is down)
        cz,                     // depth for sorting
    ];
}

/** Compute the perspective scale factor at a given camera-space depth. */
export function depthScale(cz: number, focalLength: number): number {
    return focalLength / Math.max(cz, 1);
}

/** Unproject screen coordinates back to world space at a given camera-space depth.
 *  Used for node dragging in 3D. */
export function unprojectFromScreen(
    sx: number, sy: number,
    depth: number,
    rotMatrix: Mat3,
    camDistance: number,
    focalLength: number,
    canvasCx: number,
    canvasCy: number,
): Vec3 {
    const scale = focalLength / depth;
    const cam_x = (sx - canvasCx) / scale;
    const cam_y = -(sy - canvasCy) / scale;
    const cam_z = depth - camDistance;
    // Inverse rotation (rotation matrix is orthogonal, so inverse = transpose)
    const inv: Mat3 = [
        rotMatrix[0], rotMatrix[3], rotMatrix[6],
        rotMatrix[1], rotMatrix[4], rotMatrix[7],
        rotMatrix[2], rotMatrix[5], rotMatrix[8],
    ];
    return rotatePoint(inv, cam_x, cam_y, cam_z);
}
