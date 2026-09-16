const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');

/**
 * One clock-in/clock-out pair for a staff member.
 *
 * A row is created on entry with `status: 'IN'` and closed on exit, so an open
 * row is the definition of "currently on site" — which is what the gate screen
 * and the monthly report both read.
 *
 * `enteredBy` / `exitBy` record who marked it, because a guard may clock
 * themselves in or the gatekeeper may do it for them, and the monthly report
 * has to be able to tell those apart.
 */
const attendanceSchema = new Schema({
  employeeId: { type: Schema.Types.ObjectId, ref: 'SocietyEmployee', required: true },

  clockInTime: { type: Date, required: true, default: Date.now },
  clockOutTime: { type: Date, default: null },
  totalSeconds: { type: Number, default: null },

  status: { type: String, enum: ['IN', 'EXIT'], default: 'IN' },
  enteredBy: { type: Schema.Types.ObjectId, ref: 'SocietyEmployee', default: null },
  exitBy: { type: Schema.Types.ObjectId, ref: 'SocietyEmployee', default: null },
}, { timestamps: true, collection: 'society_employeeattendances' });

attendanceSchema.plugin(societyGuard);
attendanceSchema.index({ employeeId: 1, clockInTime: -1 });
attendanceSchema.index({ societyId: 1, status: 1, clockInTime: -1 });
attendanceSchema.index({ societyId: 1, employeeId: 1, clockInTime: -1 });

module.exports = model('SocietyEmployeeAttendance', attendanceSchema);
