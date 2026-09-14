// _test_log_rotate 的被测子进程: 受控小阈值下制造真实轮转
import {createLogger} from '../log.mjs';
const log=createLogger({env:process.env});

const PAD = 'F'.repeat(20000);   // 远超 LOG_MAX_BYTES=1000 与流高水位(16KB 边界), 确保已落盘
log.info('ROTATE_FILLER', { pad: PAD });
await new Promise((r) => setTimeout(r, 120));    // 等待首条冲刷到 fd, 让下一次 statSync 看到超限体积
log.info('ROTATE_MARKER_42', { note: 'rotation boundary write' });
log.info('AFTER_ROTATE', { note: 'post-rotation write' });
await new Promise((r) => setTimeout(r, 400));    // 等待写流冲刷
