/* * (c) Copyright Ascensio System SIA 2010-2016 * * This program is a free software product. You can redistribute it and/or * modify it under the terms of the GNU Affero General Public License (AGPL) * version 3 as published by the Free Software Foundation. In accordance with * Section 7(a) of the GNU AGPL its Section 15 shall be amended to the effect * that Ascensio System SIA expressly excludes the warranty of non-infringement * of any third-party rights. * * This program is distributed WITHOUT ANY WARRANTY; without even the implied * warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR  PURPOSE. For * details, see the GNU AGPL at: http://www.gnu.org/licenses/agpl-3.0.html * * You can contact Ascensio System SIA at Lubanas st. 125a-25, Riga, Latvia, * EU, LV-1021. * * The  interactive user interfaces in modified source and object code versions * of the Program must display Appropriate Legal Notices, as required under * Section 5 of the GNU AGPL version 3. * * Pursuant to Section 7(b) of the License you must retain the original Product * logo when distributing the program. Pursuant to Section 7(e) we decline to * grant you any rights under trademark law for use of our trademarks. * * All the Product's GUI elements, including illustrations and icon sets, as * well as technical writing content are licensed under the terms of the * Creative Commons Attribution-ShareAlike 4.0 International. See the License * terms at http://creativecommons.org/licenses/by-sa/4.0/legalcode * */var pathModule = require('path');var urlModule = require('url');var co = require('co');var sqlBase = require('./baseConnector');var docsCoServer = require('./DocsCoServer');var taskResult = require('./taskresult');var logger = require('./../../Common/sources/logger');var utils = require('./../../Common/sources/utils');var constants = require('./../../Common/sources/constants');var commonDefines = require('./../../Common/sources/commondefines');var storage = require('./../../Common/sources/storage-base');var formatChecker = require('./../../Common/sources/formatchecker');var statsDClient = require('./../../Common/sources/statsdclient');var config = require('config');var config_server = config.get('services.CoAuthoring.server');var config_utils = config.get('services.CoAuthoring.utils');var pubsubRedis = require('./pubsubRedis');var cfgTypesUpload = config_utils.get('limits_image_types_upload');var cfgTypesCopy = config_utils.get('limits_image_types_copy');var cfgImageSize = config_server.get('limits_image_size');var cfgImageDownloadTimeout = config_server.get('limits_image_download_timeout');var cfgRedisPrefix = config.get('services.CoAuthoring.redis.prefix');var cfgTokenEnableBrowser = config.get('services.CoAuthoring.token.enable.browser');var SAVE_TYPE_PART_START = 0;var SAVE_TYPE_PART = 1;var SAVE_TYPE_COMPLETE = 2;var SAVE_TYPE_COMPLETE_ALL = 3;var clientStatsD = statsDClient.getClient();var redisClient = pubsubRedis.getClientRedis();var redisKeySaved = cfgRedisPrefix + constants.REDIS_KEY_SAVED;var redisKeyShutdown = cfgRedisPrefix + constants.REDIS_KEY_SHUTDOWN;function OutputDataWrap(type, data) {  this['type'] = type;  this['data'] = data;}OutputDataWrap.prototype = {  fromObject: function(data) {    this['type'] = data['type'];    this['data'] = new OutputData();    this['data'].fromObject(data['data']);  },  getType: function() {    return this['type'];  },  setType: function(data) {    this['type'] = data;  },  getData: function() {    return this['data'];  },  setData: function(data) {    this['data'] = data;  }};function OutputData(type) {  this['type'] = type;  this['status'] = undefined;  this['data'] = undefined;}OutputData.prototype = {  fromObject: function(data) {    this['type'] = data['type'];    this['status'] = data['status'];    this['data'] = data['data'];  },  getType: function() {    return this['type'];  },  setType: function(data) {    this['type'] = data;  },  getStatus: function() {    return this['status'];  },  setStatus: function(data) {    this['status'] = data;  },  getData: function() {    return this['data'];  },  setData: function(data) {    this['data'] = data;  }};function* getOutputData(cmd, outputData, key, status, statusInfo, optConn, optAdditionalOutput) {  var docId = cmd.getDocId();  switch (status) {    case taskResult.FileStatus.SaveVersion:    case taskResult.FileStatus.UpdateVersion:    case taskResult.FileStatus.Ok:      if(taskResult.FileStatus.Ok == status) {        outputData.setStatus('ok');      } else if(taskResult.FileStatus.SaveVersion == status) {        if ((optConn && optConn.user.view) || optConn.isCloseCoAuthoring) {          outputData.setStatus('updateversion');        } else {          var updateMask = new taskResult.TaskResultData();          updateMask.key = docId;          updateMask.status = status;          updateMask.statusInfo = statusInfo;          var updateTask = new taskResult.TaskResultData();          updateTask.status = taskResult.FileStatus.Ok;          updateTask.statusInfo = constants.NO_ERROR;          var updateIfRes = yield taskResult.updateIf(updateTask, updateMask);          if (updateIfRes.affectedRows > 0) {            outputData.setStatus('ok');          } else {            outputData.setStatus('updateversion');          }        }      } else {        outputData.setStatus('updateversion');      }      var command = cmd.getCommand();      if ('open' != command && 'reopen' != command) {        var strPath = key + '/' + cmd.getOutputPath();        if (optConn) {          var contentDisposition = cmd.getInline() ? constants.CONTENT_DISPOSITION_INLINE : constants.CONTENT_DISPOSITION_ATTACHMENT;          outputData.setData(yield storage.getSignedUrl(optConn.baseUrl, strPath, null, cmd.getTitle(), contentDisposition));        } else if (optAdditionalOutput) {          optAdditionalOutput.needUrlKey = strPath;          optAdditionalOutput.needUrlMethod = 2;        }      } else {        if (optConn) {          outputData.setData(yield storage.getSignedUrls(optConn.baseUrl, key));        } else if (optAdditionalOutput) {          optAdditionalOutput.needUrlKey = key;          optAdditionalOutput.needUrlMethod = 0;        }      }      break;    case taskResult.FileStatus.NeedParams:      outputData.setStatus('needparams');      var settingsPath = key + '/' + 'settings.json';      if (optConn) {        outputData.setData(yield storage.getSignedUrl(optConn.baseUrl, settingsPath));      } else if (optAdditionalOutput) {        optAdditionalOutput.needUrlKey = settingsPath;        optAdditionalOutput.needUrlMethod = 1;      }      break;    case taskResult.FileStatus.NeedPassword:      outputData.setStatus('needpassword');      outputData.setData(statusInfo);      break;    case taskResult.FileStatus.Err:    case taskResult.FileStatus.ErrToReload:      outputData.setStatus('err');      outputData.setData(statusInfo);      if (taskResult.FileStatus.ErrToReload == status) {        yield cleanupCache(key);      }      break;  }}function* addRandomKeyTaskCmd(cmd) {  var task = yield* taskResult.addRandomKeyTask(cmd.getDocId());  cmd.setSaveKey(task.key);}function* saveParts(cmd) {  var result = false;  var saveType = cmd.getSaveType();  var filename;  if (SAVE_TYPE_COMPLETE_ALL === saveType) {    filename = 'Editor.bin';  } else {    filename = 'Editor' + (cmd.getSaveIndex() || '') + '.bin';  }  if (SAVE_TYPE_PART_START === saveType || SAVE_TYPE_COMPLETE_ALL === saveType) {    yield* addRandomKeyTaskCmd(cmd);  }  if (cmd.getUrl()) {    result = true;  } else {    var buffer = cmd.getData();    yield storage.putObject(cmd.getSaveKey() + '/' + filename, buffer, buffer.length);    //delete data to prevent serialize into json    cmd.data = null;    result = (SAVE_TYPE_COMPLETE_ALL === saveType || SAVE_TYPE_COMPLETE === saveType);  }  return result;}function getSaveTask(cmd) {  cmd.setData(null);  var queueData = new commonDefines.TaskQueueData();  queueData.setCmd(cmd);  queueData.setToFile(constants.OUTPUT_NAME + '.' + formatChecker.getStringFromFormat(cmd.getOutputFormat()));  //todo paid  //if (cmd.vkey) {  //  bool  //  bPaid;  //  Signature.getVKeyParams(cmd.vkey, out bPaid);  //  oTaskQueueData.m_bPaid = bPaid;  //}  return queueData;}function getUpdateResponse(cmd) {  var updateTask = new taskResult.TaskResultData();  updateTask.key = cmd.getSaveKey() ? cmd.getSaveKey() : cmd.getDocId();  var statusInfo = cmd.getStatusInfo();  if (constants.NO_ERROR == statusInfo) {    updateTask.status = taskResult.FileStatus.Ok;  } else if (constants.CONVERT_DOWNLOAD == statusInfo) {    updateTask.status = taskResult.FileStatus.ErrToReload;  } else if (constants.CONVERT_NEED_PARAMS == statusInfo) {    updateTask.status = taskResult.FileStatus.NeedParams;  } else if (constants.CONVERT_DRM == statusInfo || constants.CONVERT_PASSWORD == statusInfo) {    updateTask.status = taskResult.FileStatus.NeedPassword;  } else {    updateTask.status = taskResult.FileStatus.Err;  }  updateTask.statusInfo = statusInfo;  if (cmd.getTitle()) {    updateTask.title = cmd.getTitle();  }  return updateTask;}var cleanupCache = co.wrap(function* (docId) {  //todo redis ?  var res = false;  var removeRes = yield taskResult.remove(docId);  if (removeRes.affectedRows > 0) {    yield storage.deletePath(docId);    res = true;  }  return res;});function commandOpenStartPromise(docId, cmd, opt_updateUserIndex) {  var task = new taskResult.TaskResultData();  task.key = docId;  task.status = taskResult.FileStatus.WaitQueue;  task.statusInfo = constants.NO_ERROR;  if (cmd) {    task.title = cmd.getTitle();  } else {    logger.warn("commandOpenStartPromise empty cmd: docId = %s", docId);  }  return taskResult.upsert(task, opt_updateUserIndex);}function* commandOpen(conn, cmd, outputData, opt_upsertRes) {  var upsertRes;  if (opt_upsertRes) {    upsertRes = opt_upsertRes;  } else {    upsertRes = yield commandOpenStartPromise(cmd.getDocId(), cmd);  }  //if CLIENT_FOUND_ROWS don't specify 1 row is inserted , 2 row is updated, and 0 row is set to its current values  //http://dev.mysql.com/doc/refman/5.7/en/insert-on-duplicate.html  var bCreate = upsertRes.affectedRows == 1;  if (!bCreate) {    var selectRes = yield taskResult.select(cmd.getDocId());    if (selectRes.length > 0) {      var row = selectRes[0];      yield* getOutputData(cmd, outputData, cmd.getDocId(), row.status, row.status_info, conn);    }  } else {    //add task    cmd.setOutputFormat(constants.AVS_OFFICESTUDIO_FILE_CANVAS);    cmd.setEmbeddedFonts(false);    var dataQueue = new commonDefines.TaskQueueData();    dataQueue.setCmd(cmd);    dataQueue.setToFile('Editor.bin');    var priority = constants.QUEUE_PRIORITY_HIGH;    var formatIn = formatChecker.getFormatFromString(cmd.getFormat());    //decrease pdf, djvu, xps convert priority becase long open time    if (constants.AVS_OFFICESTUDIO_FILE_CROSSPLATFORM_PDF === formatIn || constants.AVS_OFFICESTUDIO_FILE_CROSSPLATFORM_DJVU === formatIn ||      constants.AVS_OFFICESTUDIO_FILE_CROSSPLATFORM_XPS === formatIn) {      priority = constants.QUEUE_PRIORITY_LOW;    }    yield* docsCoServer.addTask(dataQueue, priority);  }}function* commandReopen(cmd) {  var task = new taskResult.TaskResultData();  task.key = cmd.getDocId();  task.status = taskResult.FileStatus.WaitQueue;  task.statusInfo = constants.NO_ERROR;  var upsertRes = yield taskResult.update(task);  if (upsertRes.affectedRows > 0) {    //add task    cmd.setUrl(null);//url may expire    cmd.setSaveKey(cmd.getDocId());    cmd.setOutputFormat(constants.AVS_OFFICESTUDIO_FILE_CANVAS);    cmd.setEmbeddedFonts(false);    var dataQueue = new commonDefines.TaskQueueData();    dataQueue.setCmd(cmd);    dataQueue.setToFile('Editor.bin');    dataQueue.setFromSettings(true);    yield* docsCoServer.addTask(dataQueue, constants.QUEUE_PRIORITY_HIGH);  }}function* commandSave(cmd, outputData) {  var completeParts = yield* saveParts(cmd);  if (completeParts) {    var queueData = getSaveTask(cmd);    yield* docsCoServer.addTask(queueData, constants.QUEUE_PRIORITY_LOW);  }  outputData.setStatus('ok');  outputData.setData(cmd.getSaveKey());}function* commandSendMailMerge(cmd, outputData) {  var completeParts = yield* saveParts(cmd);  var isErr = false;  if (completeParts) {    isErr = true;    var getRes = yield* docsCoServer.getCallback(cmd.getDocId());    if (getRes) {      var mailMergeSend = cmd.getMailMergeSend();      mailMergeSend.setUrl(getRes.server.href);      mailMergeSend.setBaseUrl(getRes.baseUrl);      //меняем JsonKey и SaveKey, новый key нужет потому что за одну конвертацию делается часть, а json нужен всегда      mailMergeSend.setJsonKey(cmd.getSaveKey());      mailMergeSend.setRecordErrorCount(0);      yield* addRandomKeyTaskCmd(cmd);      var queueData = getSaveTask(cmd);      yield* docsCoServer.addTask(queueData, constants.QUEUE_PRIORITY_LOW);      isErr = false;    }  }  if (isErr) {    outputData.setStatus('err');    outputData.setData(constants.UNKNOWN);  } else {    outputData.setStatus('ok');    outputData.setData(cmd.getSaveKey());  }}function* commandSfctByCmd(cmd) {  yield* addRandomKeyTaskCmd(cmd);  var queueData = getSaveTask(cmd);  queueData.setFromChanges(true);  yield* docsCoServer.addTask(queueData, constants.QUEUE_PRIORITY_LOW);}function* commandSfct(cmd, outputData) {  yield* commandSfctByCmd(cmd);  outputData.setStatus('ok');}function isDisplayedImage(strName) {  var res = 0;  if (strName) {    //шаблон display[N]image.ext    var findStr = constants.DISPLAY_PREFIX;    var index = strName.indexOf(findStr);    if (-1 != index) {      if (index + findStr.length < strName.length) {        var displayN = parseInt(strName[index + findStr.length]);        if (1 <= displayN && displayN <= 6) {          var imageIndex = index + findStr.length + 1;          if (imageIndex == strName.indexOf("image", imageIndex))            res = displayN;        }      }    }  }  return res;}function* commandImgurls(conn, cmd, outputData) {  var supportedFormats;  var urls;  var docId = cmd.getDocId();  var errorCode = constants.NO_ERROR;  if (!conn.user.view && !conn.isCloseCoAuthoring) {    var isImgUrl = 'imgurl' == cmd.getCommand();    if (isImgUrl) {      urls = [cmd.getData()];      supportedFormats = cfgTypesUpload || 'jpg';    } else {      urls = cmd.getData();      supportedFormats = cfgTypesCopy || 'jpg';    }    //todo Promise.all()    var displayedImageMap = {};//to make one imageIndex for ole object urls    var imageCount = 0;    var outputUrls = [];    for (var i = 0; i < urls.length; ++i) {      var urlSource = urls[i];      var urlParsed;      var data = undefined;      if (urlSource.startsWith('data:')) {        var delimiterIndex = urlSource.indexOf(',');        if (-1 != delimiterIndex && (urlSource.length - (delimiterIndex + 1)) * 0.75 <= cfgImageSize) {          data = new Buffer(urlSource.substring(delimiterIndex + 1), 'base64');        }      } else if (urlSource) {        //todo stream        data = yield utils.downloadUrlPromise(urlSource, cfgImageDownloadTimeout * 1000, cfgImageSize);        urlParsed = urlModule.parse(urlSource);      }      var outputUrl = {url: 'error', path: 'error'};      if (data) {        var format = formatChecker.getImageFormat(data);        var formatStr;        if (constants.AVS_OFFICESTUDIO_FILE_UNKNOWN == format && urlParsed) {          //bin, txt occur in ole object case          var ext = pathModule.extname(urlParsed.pathname);          if ('.bin' == ext || '.txt' == ext) {            formatStr = ext.substring(1);          }        } else {          formatStr = formatChecker.getStringFromFormat(format);        }        if (formatStr && -1 !== supportedFormats.indexOf(formatStr)) {          var userid = cmd.getUserId();          var imageIndex = cmd.getSaveIndex() + imageCount;          imageCount++;          var strLocalPath = 'media/' + utils.crc32(userid).toString(16) + '_';          if (urlParsed) {            var urlBasename = pathModule.basename(urlParsed.pathname);            var displayN = isDisplayedImage(urlBasename);            if (displayN > 0) {              var displayedImageName = urlBasename.substring(0, urlBasename.length - formatStr.length - 1);              var tempIndex = displayedImageMap[displayedImageName];              if (null != tempIndex) {                imageIndex = tempIndex;                imageCount--;              } else {                displayedImageMap[displayedImageName] = imageIndex;              }              strLocalPath += constants.DISPLAY_PREFIX + displayN;            }          }          strLocalPath += 'image' + imageIndex + '.' + formatStr;          var strPath = cmd.getDocId() + '/' + strLocalPath;          yield storage.putObject(strPath, data, data.length);          var imgUrl = yield storage.getSignedUrl(conn.baseUrl, strPath);          outputUrl = {url: imgUrl, path: strLocalPath};        }      }      if (isImgUrl && ('error' === outputUrl.url || 'error' === outputUrl.path)) {        errorCode = constants.UPLOAD_EXTENSION;        break;      }      outputUrls.push(outputUrl);    }  } else {    logger.error('error commandImgurls: docId = %s access deny', docId);    errorCode = errorCode.UPLOAD;  }  if (constants.NO_ERROR !== errorCode) {    outputData.setStatus('err');    outputData.setData(errorCode);  } else {    outputData.setStatus('ok');    outputData.setData(outputUrls);  }}function* commandPathUrl(conn, cmd, outputData) {  var contentDisposition = cmd.getInline() ? constants.CONTENT_DISPOSITION_INLINE :    constants.CONTENT_DISPOSITION_ATTACHMENT;  var strPath = cmd.getDocId() + '/' + cmd.getData();  var url = yield storage.getSignedUrl(conn.baseUrl, strPath, null, cmd.getTitle(), contentDisposition);  var errorCode = constants.NO_ERROR;  if (constants.NO_ERROR !== errorCode) {    outputData.setStatus('err');    outputData.setData(errorCode);  } else {    outputData.setStatus('ok');    outputData.setData(url);  }}function* commandSaveFromOrigin(cmd, outputData) {  yield* addRandomKeyTaskCmd(cmd);  var queueData = getSaveTask(cmd);  queueData.setFromOrigin(true);  yield* docsCoServer.addTask(queueData, constants.QUEUE_PRIORITY_LOW);  outputData.setStatus('ok');  outputData.setData(cmd.getSaveKey());}function* commandSfcCallback(cmd, isSfcm) {  var docId = cmd.getDocId();  logger.debug('Start commandSfcCallback: docId = %s', docId);  var saveKey = cmd.getSaveKey();  var statusInfo = cmd.getStatusInfo();  var isError = constants.NO_ERROR != statusInfo && constants.CONVERT_CORRUPTED != statusInfo;  var savePathDoc = saveKey + '/' + cmd.getOutputPath();  var savePathChanges = saveKey + '/changes.zip';  var savePathHistory = saveKey + '/changesHistory.json';  var getRes = yield* docsCoServer.getCallback(docId);  if (getRes) {    logger.debug('Callback commandSfcCallback: docId = %s callback = %s', docId, getRes.server.href);    var outputSfc = new commonDefines.OutputSfcData();    outputSfc.setKey(docId);    var users = [];    if (cmd.getUserId()) {      users.push(cmd.getUserId());    }    outputSfc.setUsers(users);    if (!isSfcm) {      var actions = [];      //use UserId case UserActionId miss in gc convertion      var userActionId = cmd.getUserActionId() || cmd.getUserId();      if (userActionId) {        actions.push(new commonDefines.OutputAction(commonDefines.c_oAscUserAction.Out, userActionId));      }      outputSfc.setActions(actions);    }    outputSfc.setUserData(cmd.getUserData());    if (!isError) {      try {        var data = yield storage.getObject(savePathHistory);        outputSfc.setChangeHistory(JSON.parse(data.toString('utf-8')));        outputSfc.setUrl(yield storage.getSignedUrl(getRes.baseUrl, savePathDoc));        outputSfc.setChangeUrl(yield storage.getSignedUrl(getRes.baseUrl, savePathChanges));      } catch (e) {        logger.error('Error commandSfcCallback: docId = %s\r\n%s', docId, e.stack);      }      if (outputSfc.getUrl() && outputSfc.getUsers().length > 0) {        if (isSfcm) {          outputSfc.setStatus(docsCoServer.c_oAscServerStatus.MustSaveForce);        } else {          outputSfc.setStatus(docsCoServer.c_oAscServerStatus.MustSave);        }      } else {        isError = true;      }    }    if (isError) {      if (isSfcm) {        outputSfc.setStatus(docsCoServer.c_oAscServerStatus.CorruptedForce);      } else {        outputSfc.setStatus(docsCoServer.c_oAscServerStatus.Corrupted);      }    }    var uri = getRes.server.href;    if (isSfcm) {      var lastSave = cmd.getLastSave();      if (lastSave && !isError) {        yield* docsCoServer.setForceSave(docId, lastSave, savePathDoc);      }      try {        yield* docsCoServer.sendServerRequest(docId, uri, outputSfc);      } catch (err) {        logger.error('sendServerRequest error: docId = %s;url = %s;data = %j\r\n%s', docId, uri, outputSfc, err.stack);      }    } else {      //if anybody in document stop save      var hasEditors = yield* docsCoServer.hasEditors(docId);      logger.debug('hasEditors commandSfcCallback: docId = %s hasEditors = %d', docId, hasEditors);      if (!hasEditors) {        var updateMask = new taskResult.TaskResultData();        updateMask.key = docId;        updateMask.status = taskResult.FileStatus.SaveVersion;        updateMask.statusInfo = cmd.getData();        var updateIfTask = new taskResult.TaskResultData();        updateIfTask.status = taskResult.FileStatus.UpdateVersion;        updateIfTask.statusInfo = constants.NO_ERROR;        var updateIfRes = yield taskResult.updateIf(updateIfTask, updateMask);        if (updateIfRes.affectedRows > 0) {          var replyStr = null;          try {            replyStr = yield* docsCoServer.sendServerRequest(docId, uri, outputSfc);          } catch (err) {            replyStr = null;            logger.error('sendServerRequest error: docId = %s;url = %s;data = %j\r\n%s', docId, uri, outputSfc, err.stack);          }          var requestRes = false;          var replyData = docsCoServer.parseReplyData(docId, replyStr);          if (replyData && commonDefines.c_oAscServerCommandErrors.NoError == replyData.error) {            //в случае comunity server придет запрос в CommandService проверяем результат            var multi = redisClient.multi([              ['get', redisKeySaved + docId],              ['del', redisKeySaved + docId]            ]);            var execRes = yield utils.promiseRedis(multi, multi.exec);            var savedVal = execRes[0];            requestRes = (null == savedVal || '1' === savedVal);          }          if (requestRes) {            yield docsCoServer.cleanDocumentOnExitPromise(docId, true);          } else {            var updateTask = new taskResult.TaskResultData();            updateTask.key = docId;            updateTask.status = taskResult.FileStatus.Ok;            updateTask.statusInfo = constants.NO_ERROR;            yield taskResult.update(updateTask);          }        }      }    }  }  if (docsCoServer.getIsShutdown() && !isSfcm) {    yield utils.promiseRedis(redisClient, redisClient.srem, redisKeyShutdown, docId);  }  logger.debug('End commandSfcCallback: docId = %s', docId);}function* commandSendMMCallback(cmd) {  var docId = cmd.getDocId();  logger.debug('Start commandSendMMCallback: docId = %s', docId);  var saveKey = cmd.getSaveKey();  var statusInfo = cmd.getStatusInfo();  var outputSfc = new commonDefines.OutputSfcData();  outputSfc.setKey(docId);  if (constants.NO_ERROR == statusInfo) {    outputSfc.setStatus(docsCoServer.c_oAscServerStatus.MailMerge);  } else {    outputSfc.setStatus(docsCoServer.c_oAscServerStatus.Corrupted);  }  var mailMergeSendData = cmd.getMailMergeSend();  var outputMailMerge = new commonDefines.OutputMailMerge(mailMergeSendData);  outputSfc.setMailMerge(outputMailMerge);  outputSfc.setUsers([mailMergeSendData.getUserId()]);  var data = yield storage.getObject(saveKey + '/' + cmd.getOutputPath());  var xml = data.toString('utf8');  var files = xml.match(/[< ]file.*?\/>/g);  var recordRemain = (mailMergeSendData.getRecordTo() - mailMergeSendData.getRecordFrom() + 1);  var recordIndexStart = mailMergeSendData.getRecordCount() - recordRemain;  for (var i = 0; i < files.length; ++i) {    var file = files[i];    var fieldRes = /field=["'](.*?)["']/.exec(file);    outputMailMerge.setTo(fieldRes[1]);    outputMailMerge.setRecordIndex(recordIndexStart + i);    var pathRes = /path=["'](.*?)["']/.exec(file);    var signedUrl = yield storage.getSignedUrl(mailMergeSendData.getBaseUrl(), saveKey + '/' + pathRes[1]);    outputSfc.setUrl(signedUrl);    var uri = mailMergeSendData.getUrl();    var replyStr = null;    try {      replyStr = yield* docsCoServer.sendServerRequest(docId, uri, outputSfc);    } catch (err) {      replyStr = null;      logger.error('sendServerRequest error: docId = %s;url = %s;data = %j\r\n%s', docId, uri, outputSfc, err.stack);    }    var replyData = docsCoServer.parseReplyData(docId, replyStr);    if (!(replyData && commonDefines.c_oAscServerCommandErrors.NoError == replyData.error)) {      var recordErrorCount = mailMergeSendData.getRecordErrorCount();      recordErrorCount++;      outputMailMerge.setRecordErrorCount(recordErrorCount);      mailMergeSendData.setRecordErrorCount(recordErrorCount);    }  }  var newRecordFrom = mailMergeSendData.getRecordFrom() + Math.max(files.length, 1);  if (newRecordFrom <= mailMergeSendData.getRecordTo()) {    mailMergeSendData.setRecordFrom(newRecordFrom);    yield* addRandomKeyTaskCmd(cmd);    var queueData = getSaveTask(cmd);    yield* docsCoServer.addTask(queueData, constants.QUEUE_PRIORITY_LOW);  } else {    logger.debug('End MailMerge: docId = %s', docId);  }  logger.debug('End commandSendMMCallback: docId = %s', docId);}exports.openDocument = function(conn, cmd, opt_upsertRes) {  return co(function* () {    var outputData;    var docId = conn ? conn.docId : 'null';    try {      var startDate = null;      if(clientStatsD) {        startDate = new Date();      }      logger.debug('Start command: docId = %s %s', docId, JSON.stringify(cmd));      outputData = new OutputData(cmd.getCommand());      switch (cmd.getCommand()) {        case 'open':          //yield utils.sleep(5000);          yield* commandOpen(conn, cmd, outputData, opt_upsertRes);          break;        case 'reopen':          yield* commandReopen(cmd);          break;        case 'imgurl':        case 'imgurls':          yield* commandImgurls(conn, cmd, outputData);          break;        case 'pathurl':          yield* commandPathUrl(conn, cmd, outputData);          break;        default:          outputData.setStatus('err');          outputData.setData(constants.UNKNOWN);          break;      }      if(clientStatsD) {        clientStatsD.timing('coauth.openDocument.' + cmd.getCommand(), new Date() - startDate);      }    }    catch (e) {      logger.error('Error openDocument: docId = %s\r\n%s', docId, e.stack);      if (!outputData) {        outputData = new OutputData();      }      outputData.setStatus('err');      outputData.setData(constants.UNKNOWN);    }    finally {      if (outputData && outputData.getStatus()) {        logger.debug('Response command: docId = %s %s', docId, JSON.stringify(outputData));        docsCoServer.sendData(conn, new OutputDataWrap('documentOpen', outputData));      }      logger.debug('End command: docId = %s', docId);    }  });};exports.downloadAs = function(req, res) {  return co(function* () {    var docId = 'null';    try {      var startDate = null;      if(clientStatsD) {        startDate = new Date();      }      var strCmd = req.query['cmd'];      var cmd = new commonDefines.InputCommand(JSON.parse(strCmd));      docId = cmd.getDocId();      logger.debug('Start downloadAs: docId = %s %s', docId, strCmd);      if (cfgTokenEnableBrowser) {        var isValidJwt = false;        var checkJwtRes = docsCoServer.checkJwt(docId, cmd.getJwt());        if (checkJwtRes.decoded) {          var doc = checkJwtRes.decoded.document;          if (doc.permissions && (false !== doc.permissions.download || false !== doc.permissions.print)) {            isValidJwt = true;            docId = doc.key;            cmd.setDocId(doc.key);          } else {            logger.error('Error downloadAs jwt: docId = %s\r\n%s', docId, 'access deny');          }        } else {          logger.error('Error downloadAs jwt: docId = %s\r\n%s', docId, checkJwtRes.description);        }        if (!isValidJwt) {          res.sendStatus(400);          return;        }      }      cmd.setData(req.body);      var outputData = new OutputData(cmd.getCommand());      switch (cmd.getCommand()) {        case 'save':          yield* commandSave(cmd, outputData);          break;        case 'savefromorigin':          yield* commandSaveFromOrigin(cmd, outputData);          break;        case 'sendmm':          yield* commandSendMailMerge(cmd, outputData);          break;        case 'sfct':          yield* commandSfct(cmd, outputData);          break;        default:          outputData.setStatus('err');          outputData.setData(constants.UNKNOWN);          break;      }      var strRes = JSON.stringify(outputData);      res.send(strRes);      logger.debug('End downloadAs: docId = %s %s', docId, strRes);      if(clientStatsD) {        clientStatsD.timing('coauth.downloadAs.' + cmd.getCommand(), new Date() - startDate);      }    }    catch (e) {      logger.error('Error downloadAs: docId = %s\r\n%s', docId, e.stack);      res.sendStatus(400);    }  });};exports.saveFromChanges = function(docId, statusInfo, optFormat, opt_userId, opt_queue) {  return co(function* () {    try {      var startDate = null;      if(clientStatsD) {        startDate = new Date();      }      logger.debug('Start saveFromChanges: docId = %s', docId);      var task = new taskResult.TaskResultData();      task.key = docId;      //делаем select, потому что за время timeout информация могла измениться      var selectRes = yield taskResult.select(docId);      var row = selectRes.length > 0 ? selectRes[0] : null;      if (row && row.status == taskResult.FileStatus.SaveVersion && row.status_info == statusInfo) {        if (null == optFormat) {          optFormat = constants.AVS_OFFICESTUDIO_FILE_OTHER_TEAMLAB_INNER;        }        var cmd = new commonDefines.InputCommand();        cmd.setCommand('sfc');        cmd.setDocId(docId);        cmd.setOutputFormat(optFormat);        cmd.setData(statusInfo);        cmd.setUserActionId(opt_userId);        yield* addRandomKeyTaskCmd(cmd);        var queueData = getSaveTask(cmd);        queueData.setFromChanges(true);        yield* docsCoServer.addTask(queueData, constants.QUEUE_PRIORITY_NORMAL, opt_queue);        if (docsCoServer.getIsShutdown()) {          yield utils.promiseRedis(redisClient, redisClient.sadd, redisKeyShutdown, docId);        }        logger.debug('AddTask saveFromChanges: docId = %s', docId);      } else {        if (row) {          logger.debug('saveFromChanges status mismatch: docId = %s; row: %d; %d; expected: %d', docId, row.status, row.status_info, statusInfo);        }      }      if (clientStatsD) {        clientStatsD.timing('coauth.saveFromChanges', new Date() - startDate);      }    }    catch (e) {      logger.error('Error saveFromChanges: docId = %s\r\n%s', docId, e.stack);    }  });};exports.receiveTask = function(data, dataRaw) {  return co(function* () {    var docId = 'null';    try {      var task = new commonDefines.TaskQueueData(JSON.parse(data));      if (task) {        var cmd = task.getCmd();        docId = cmd.getDocId();        logger.debug('Start receiveTask: docId = %s %s', docId, data);        var updateTask = getUpdateResponse(cmd);        var updateRes = yield taskResult.update(updateTask);        if (updateRes.affectedRows > 0) {          var outputData = new OutputData(cmd.getCommand());          var command = cmd.getCommand();          var additionalOutput = {needUrlKey: null, needUrlMethod: null};          if ('open' == command || 'reopen' == command) {            //yield utils.sleep(5000);            yield* getOutputData(cmd, outputData, cmd.getDocId(), updateTask.status,              updateTask.statusInfo, null, additionalOutput);          } else if ('save' == command || 'savefromorigin' == command || 'sfct' == command) {            yield* getOutputData(cmd, outputData, cmd.getSaveKey(), updateTask.status,              updateTask.statusInfo, null, additionalOutput);          } else if ('sfcm' == command) {            yield* commandSfcCallback(cmd, true);          } else if ('sfc' == command) {            yield* commandSfcCallback(cmd, false);          } else if ('sendmm' == command) {            yield* commandSendMMCallback(cmd);          } else if ('conv' == command) {            //nothing          }          if (outputData.getStatus()) {            logger.debug('Send receiveTask: docId = %s %s', docId, JSON.stringify(outputData));            var output = new OutputDataWrap('documentOpen', outputData);            yield* docsCoServer.publish({              type: commonDefines.c_oPublishType.receiveTask, cmd: cmd, output: output,              needUrlKey: additionalOutput.needUrlKey, needUrlMethod: additionalOutput.needUrlMethod            });          }        }        yield* docsCoServer.removeResponse(dataRaw);        logger.debug('End receiveTask: docId = %s', docId);      }    } catch (err) {      logger.debug('Error receiveTask: docId = %s\r\n%s', docId, err.stack);    }  });};exports.cleanupCache = cleanupCache;exports.commandSfctByCmd = commandSfctByCmd;exports.commandOpenStartPromise = commandOpenStartPromise;exports.OutputDataWrap = OutputDataWrap;exports.OutputData = OutputData;