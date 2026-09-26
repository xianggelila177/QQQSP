// Finite non-positive prices are valid only for the futures domain. Keep the
// default strict so cash securities never inherit a futures exception.
export const validPrice=(value,instrumentType='EQUITY')=>
  typeof value==='number'&&Number.isFinite(value)&&(instrumentType==='FUTURE'||value>0);
