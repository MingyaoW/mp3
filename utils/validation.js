const mongoose = require("mongoose");

function isNonEmptyString(value) {
  return typeof value === "string" &&
    value.trim().length > 0;
}

function isValidId(id) {
  return typeof id === "string" &&
    /^[0-9a-fA-F]{24}$/.test(id) &&
    mongoose.isValidObjectId(id);
}

function isValidDate(value) {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    !Number.isNaN(Date.parse(value));
}


function isInvalidQueryError(err) {
  if (!err) return false;

  if (
    err.name === "CastError" ||
    err.name === "StrictModeError"
  ) {
    return true;
  }

  if (
    err.name === "MongoServerError" &&
    [2, 9].includes(err.code)
  ) {
    return true;
  }

  return false;
}


function validateUser(body) {
  if (new Set(body.pendingTasks).size !== body.pendingTasks.length) {
    return "pendingTasks must not contain duplicate IDs";
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "Invalid user data";
  }

  if (!isNonEmptyString(body.name)) {
    return "User name is required";
  }

  if (!isNonEmptyString(body.email)) {
    return "User email is required";
  }

  if (body.pendingTasks !== undefined) {
    if (!Array.isArray(body.pendingTasks)) {
      return "pendingTasks must be an array";
    }

    if (!body.pendingTasks.every(isValidId)) {
      return "pendingTasks must contain valid task IDs";
    }
  }

  return null;
}

function validateTask(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "Invalid task data";
  }

  if (!isNonEmptyString(body.name)) {
    return "Task name is required";
  }

  if (!isValidDate(body.deadline)) {
    return "A valid deadline is required";
  }

  if (
    body.description !== undefined &&
    typeof body.description !== "string"
  ) {
    return "Description must be a string";
  }

  if (
    body.completed !== undefined &&
    typeof body.completed !== "boolean"
  ) {
    return "Completed must be a boolean";
  }

  if (
    body.assignedUser !== undefined &&
    body.assignedUser !== "" &&
    !isValidId(body.assignedUser)
  ) {
    return "Invalid assignedUser ID";
  }

  if (
    body.assignedUserName !== undefined &&
    typeof body.assignedUserName !== "string"
  ) {
    return "assignedUserName must be a string";
  }

  return null;
}




function parseJsonObject(value, name) {
  if (value === undefined) return {};

  let parsed;

  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Invalid JSON in ${name}`);
  }

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new Error(`${name} must be a JSON object`);
  }

  return parsed;
}

function parseNonNegativeInteger(value, name) {
  if (value === undefined) return undefined;

  const str = String(value);

  if (!/^\d+$/.test(str)) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  const number = Number(str);

  if (!Number.isSafeInteger(number)) {
    throw new Error(`Invalid ${name}`);
  }

  return number;
}

function parseSelect(value) {
  const select = parseJsonObject(value, "select");

  for (const flag of Object.values(select)) {
    if (flag !== 0 && flag !== 1) {
      throw new Error("select values must be 0 or 1");
    }
  }

  return select;
}


function validateWhereOperators(value) {
  const fieldOperators = new Set([
    "$eq", "$ne", "$gt", "$gte", "$lt", "$lte",
    "$in", "$nin", "$exists", "$not",
    "$regex", "$options", "$all", "$size",
    "$elemMatch", "$mod", "$type"
  ]);

  const logicalOperators = new Set([
    "$and", "$or", "$nor"
  ]);

  function inspect(obj, context = "root") {
    if (Array.isArray(obj)) {
      for (const item of obj) {
        inspect(item, context);
      }
      return;
    }

    if (obj === null || typeof obj !== "object") {
      return;
    }

    for (const [key, val] of Object.entries(obj)) {
      if (key.startsWith("$")) {
        if (context === "root" && !logicalOperators.has(key)) {
          throw new Error(`Invalid query operator: ${key}`);
        }

        if (
          context !== "root" &&
          !fieldOperators.has(key) &&
          !logicalOperators.has(key)
        ) {
          throw new Error(`Invalid query operator: ${key}`);
        }

        if (logicalOperators.has(key) && !Array.isArray(val)) {
          throw new Error(`${key} must be an array`);
        }

        if (["$in", "$nin", "$all"].includes(key) &&
            !Array.isArray(val)) {
          throw new Error(`${key} must be an array`);
        }
      }

      inspect(val, key.startsWith("$") ? context : "field");
    }
  }

  inspect(value);
}


function parseCollectionQuery(query, defaultLimit) {
  const where = parseJsonObject(query.where, "where");
  validateWhereOperators(where);
  const sort = parseJsonObject(query.sort, "sort");
  const select = parseSelect(query.select);

  for (const direction of Object.values(sort)) {
    if (direction !== 1 && direction !== -1) {
      throw new Error("sort values must be 1 or -1");
    }
  }

  const skip = parseNonNegativeInteger(query.skip, "skip") ?? 0;
  const limit = parseNonNegativeInteger(query.limit, "limit")
    ?? defaultLimit;

  let count = false;

  if (query.count !== undefined) {
    try {
      count = JSON.parse(query.count);
    } catch {
      throw new Error("Invalid count parameter");
    }

    if (typeof count !== "boolean") {
      throw new Error("count must be true or false");
    }
  }

  return { where, sort, select, skip, limit, count };
}



module.exports = {validateUser, validateTask, isValidId, parseSelect, parseCollectionQuery, isInvalidQueryError};