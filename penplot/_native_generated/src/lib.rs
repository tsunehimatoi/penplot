//! Closed-vocabulary GRBL Stepper generation. No Python API or global state.
use std::fmt::Write;
use std::slice;

#[repr(C)]
pub struct ResultData {
    text: *mut u8,
    len: usize,
    values: [f64; 13], // draw, travel, seconds, draw bbox, travel bbox, z range
    counts: [u64; 3], // lines, motions, lifts
}

struct State {
    x: f64, y: f64, z: f64, down: bool,
    z_down: f64, z_up: f64,
    values: [f64; 13], counts: [u64; 3],
}

fn bounds(values: &mut [f64], x: f64, y: f64, nx: f64, ny: f64) {
    values[0] = values[0].min(x).min(nx);
    values[1] = values[1].min(y).min(ny);
    values[2] = values[2].max(x).max(nx);
    values[3] = values[3].max(y).max(ny);
}

impl State {
    fn motion(&mut self, nx: f64, ny: f64, nz: f64, rate: f64, has_z: bool) {
        let dxy = (nx - self.x).hypot(ny - self.y);
        let dz = (nz - self.z).abs();
        let distance = (dxy * dxy + dz * dz).sqrt();
        self.values[2] += distance / rate * 60.0;
        self.counts[1] += 1;
        if has_z {
            let down = (nz - self.z_down).abs() < (nz - self.z_up).abs();
            if self.down && !down { self.counts[2] += 1; }
            self.down = down;
        }
        bounds(&mut self.values[7..11], self.x, self.y, nx, ny);
        self.values[11] = self.values[11].min(nz);
        self.values[12] = self.values[12].max(nz);
        if dxy > 0.0 {
            if self.down {
                self.values[0] += dxy;
                bounds(&mut self.values[3..7], self.x, self.y, nx, ny);
            } else { self.values[1] += dxy; }
        }
        self.x = nx; self.y = ny; self.z = nz;
    }
    fn pen(&mut self, up: bool, speed: f64) {
        self.motion(self.x, self.y, if up { self.z_up } else { self.z_down }, speed, true);
    }
}

#[no_mangle]
pub extern "C" fn penplot_generated_abi() -> u32 { 1 }

// All slices are borrowed for the duration of this call. The Python wrapper
// checks lengths and owns the buffers until the synchronous call returns.
#[no_mangle]
pub unsafe extern "C" fn penplot_generate(
    xy: *const f64, ops: *const u8, point_count: usize,
    offsets: *const u64, path_count: usize,
    config: *const f64, chunks: *const *const u8, lengths: *const usize,
) -> *mut ResultData {
    std::panic::catch_unwind(|| {
        let xy = slice::from_raw_parts(xy, point_count * 2);
        let ops = slice::from_raw_parts(ops, point_count);
        let offsets = slice::from_raw_parts(offsets, path_count + 1);
        let cfg = slice::from_raw_parts(config, 5);
        let chunks = slice::from_raw_parts(chunks, 4);
        let lengths = slice::from_raw_parts(lengths, 4);
        if cfg.iter().any(|v| !v.is_finite()) || cfg[..3].iter().any(|v| *v <= 0.0)
            || xy.iter().any(|v| !v.is_finite() || v.abs() > 1e9)
            || offsets[0] != 0 || offsets[path_count] != point_count as u64
            || offsets.windows(2).any(|w| w[0] > w[1]) {
            return std::ptr::null_mut();
        }
        let mut text_chunks = Vec::with_capacity(4);
        for i in 0..4 {
            match std::str::from_utf8(slice::from_raw_parts(chunks[i], lengths[i])) {
                Ok(s) => text_chunks.push(s), Err(_) => return std::ptr::null_mut(),
            }
        }
        let mut s = State { x: 0.0, y: 0.0, z: 0.0, down: false,
            z_down: cfg[3], z_up: cfg[4],
            values: [0., 0., 0., f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY,
                f64::NEG_INFINITY, f64::INFINITY, f64::INFINITY,
                f64::NEG_INFINITY, f64::NEG_INFINITY, 0., 0.], counts: [4, 0, 0] };
        let (feed, rapid, z_speed) = (cfg[0], cfg[1], cfg[2]);
        let mut output = String::with_capacity(point_count.saturating_mul(32));
        output.push_str(text_chunks[0]);
        s.pen(true, z_speed); // header's Z-up command
        let (mut last_x, mut last_y) = (f64::NAN, f64::NAN);
        for path in 0..path_count {
            let mut started = false;
            for i in offsets[path] as usize..offsets[path + 1] as usize {
                let (x, y) = (xy[i * 2], xy[i * 2 + 1]);
                let is_move = ops[i] == 0;
                if is_move { started = true; }
                if !started || (x == last_x && y == last_y) { continue; }
                last_x = x; last_y = y;
                if is_move {
                    output.push_str(text_chunks[1]);
                    s.pen(true, z_speed);
                    s.counts[0] += 1;
                }
                // Match fmt3's x + 0.0, including signed zero. Statistics use
                // the emitted decimal, never the unrounded input coordinate.
                let sx = format!("{:.3}", x + 0.0);
                let sy = format!("{:.3}", y + 0.0);
                let nx: f64 = sx.parse().unwrap();
                let ny: f64 = sy.parse().unwrap();
                let speed = if is_move { rapid } else { feed };
                write!(output, "G{} X{}Y{}F{}\r\n", if is_move { 0 } else { 1 }, sx, sy, speed as i64).unwrap();
                s.motion(nx, ny, s.z, speed, false);
                s.counts[0] += 1;
                if is_move {
                    output.push_str(text_chunks[2]);
                    s.pen(false, z_speed);
                    s.counts[0] += 1;
                }
            }
        }
        output.push_str(text_chunks[3]);
        s.pen(true, z_speed);
        s.motion(0.0, 0.0, s.z, rapid, false);
        s.counts[0] += 2;
        if s.down { s.counts[2] += 1; }
        let bytes = output.into_bytes().into_boxed_slice();
        let len = bytes.len();
        let ptr = Box::into_raw(bytes) as *mut u8;
        Box::into_raw(Box::new(ResultData { text: ptr, len, values: s.values, counts: s.counts }))
    }).unwrap_or(std::ptr::null_mut())
}

#[no_mangle]
pub unsafe extern "C" fn penplot_generated_free(result: *mut ResultData) {
    if !result.is_null() {
        let result = Box::from_raw(result);
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(result.text, result.len)));
    }
}
