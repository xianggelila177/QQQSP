export const contextError=(code,statusCode=400)=>Object.assign(new Error(code),{code,statusCode});
