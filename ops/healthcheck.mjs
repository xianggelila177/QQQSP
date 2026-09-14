// Readiness means process + local storage capacity, not first successful upstream price.
// dataReady stays separately observable, so a source outage cannot cause restart storms.
const port=Number(process.env.PORT||8567);
try{
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid PORT');
  const response=await fetch(`http://127.0.0.1:${port}/readyz`,{signal:AbortSignal.timeout(3500)});
  const data=await response.json();
  if(!response.ok||data.ready!==true)throw new Error('Application not ready');
}catch(error){console.error(error.message);process.exitCode=1;}
