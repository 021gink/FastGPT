import { MongoDatasetTraining } from '@fastgpt/service/core/dataset/training/schema';
import { pushQABill } from '@/service/support/wallet/bill/push';
import { DatasetDataIndexTypeEnum, TrainingModeEnum } from '@fastgpt/global/core/dataset/constant';
import { sendOneInform } from '../support/user/inform/api';
import { getAIApi } from '@fastgpt/service/core/ai/config';
import type { ChatMessageItemType } from '@fastgpt/global/core/ai/type.d';
import { addLog } from '@fastgpt/service/common/mongo/controller';
import { splitText2Chunks } from '@fastgpt/global/common/string/textSplitter';
import { replaceVariable } from '@fastgpt/global/common/string/tools';
import { Prompt_AgentQA } from '@/global/core/prompt/agent';
import { pushDataToDatasetCollection } from '@/pages/api/core/dataset/data/pushData';
import { getErrText } from '@fastgpt/global/common/error/utils';
import { authTeamBalance } from '../support/permission/auth/bill';
import type { PushDatasetDataChunkProps } from '@fastgpt/global/core/dataset/api.d';

const reduceQueue = () => {
  global.qaQueueLen = global.qaQueueLen > 0 ? global.qaQueueLen - 1 : 0;
};

export async function generateQA(): Promise<any> {
  if (global.qaQueueLen >= global.systemEnv.qaMaxProcess) return;
  global.qaQueueLen++;

  // get training data
  const {
    data,
    text,
    done = false,
    error = false
  } = await (async () => {
    try {
      const data = await MongoDatasetTraining.findOneAndUpdate(
        {
          mode: TrainingModeEnum.qa,
          lockTime: { $lte: new Date(Date.now() - 10 * 60 * 1000) }
        },
        {
          lockTime: new Date()
        }
      )
        .select({
          _id: 1,
          userId: 1,
          teamId: 1,
          tmbId: 1,
          datasetId: 1,
          collectionId: 1,
          q: 1,
          model: 1,
          billId: 1,
          prompt: 1
        })
        .lean();

      // task preemption
      if (!data) {
        return {
          done: true
        };
      }
      return {
        data,
        text: data.q
      };
    } catch (error) {
      console.log(`Get Training Data error`, error);
      return {
        error: true
      };
    }
  })();

  if (done) {
    reduceQueue();
    global.vectorQueueLen <= 0 && console.log(`【QA】Task Done`);
    return;
  }
  if (error || !data) {
    reduceQueue();
    return generateQA();
  }

  // auth balance
  try {
    await authTeamBalance(data.teamId);
  } catch (error) {
    // send inform and lock data
    try {
      sendOneInform({
        type: 'system',
        title: '文本训练任务中止',
        content:
          '该团队账号余额不足，文本训练任务中止，重新充值后将会继续。暂停的任务将在 7 天后被删除。',
        tmbId: data.tmbId
      });
      console.log('余额不足，暂停【QA】生成任务');
      await MongoDatasetTraining.updateMany(
        {
          teamId: data.teamId
        },
        {
          lockTime: new Date('2999/5/5')
        }
      );
    } catch (error) {}
    reduceQueue();
    return generateQA();
  }

  try {
    const startTime = Date.now();
    const model = data.model ?? global.qaModels[0].model;

    // request LLM to get QA
    const messages: ChatMessageItemType[] = [
      {
        role: 'user',
        content: data.prompt
          ? replaceVariable(data.prompt, { text })
          : replaceVariable(Prompt_AgentQA.prompt, {
              theme: Prompt_AgentQA.defaultTheme,
              text
            })
      }
    ];

    const ai = getAIApi(undefined, 600000);
    const chatResponse = await ai.chat.completions.create({
      model,
      temperature: 0.01,
      messages,
      stream: false
    });
    const answer = chatResponse.choices?.[0].message?.content || '';
    const totalTokens = chatResponse.usage?.total_tokens || 0;

    const qaArr = formatSplitText(answer, text); // 格式化后的QA对

    // get vector and insert
    await pushDataToDatasetCollection({
      teamId: data.teamId,
      tmbId: data.tmbId,
      collectionId: data.collectionId,
      data: qaArr,
      mode: TrainingModeEnum.chunk,
      billId: data.billId
    });

    // delete data from training
    await MongoDatasetTraining.findByIdAndDelete(data._id);

    addLog.info(`QA Training Finish`, {
      time: `${(Date.now() - startTime) / 1000}s`,
      splitLength: qaArr.length,
      usage: chatResponse.usage
    });

    // add bill
    if (qaArr.length > 0) {
      pushQABill({
        teamId: data.teamId,
        tmbId: data.tmbId,
        totalTokens,
        billId: data.billId,
        model
      });
    } else {
      addLog.info(`QA result 0:`, { answer });
    }

    reduceQueue();
    generateQA();
  } catch (err: any) {
    reduceQueue();
    // log
    if (err?.response) {
      addLog.info('openai error: 生成QA错误', {
        status: err.response?.status,
        stateusText: err.response?.statusText,
        data: err.response?.data
      });
    } else {
      console.log(err);
      addLog.error(getErrText(err, '生成 QA 错误'));
    }

    // message error or openai account error
    if (
      err?.message === 'invalid message format' ||
      err.response?.data?.error?.type === 'invalid_request_error' ||
      err?.code === 500
    ) {
      addLog.info('invalid message format', {
        text
      });
      try {
        await MongoDatasetTraining.findByIdAndUpdate(data._id, {
          lockTime: new Date('2998/5/5')
        });
      } catch (error) {}
      return generateQA();
    }

    setTimeout(() => {
      generateQA();
    }, 1000);
  }
}

/**
 * 检查文本是否按格式返回
 */
function formatSplitText(text: string, rawText: string) {
  text = text.replace(/\\n/g, '\n'); // 将换行符替换为空格
  const regex = /Q\d+:(\s*)(.*)(\s*)A\d+:(\s*)([\s\S]*?)(?=Q|$)/g; // 匹配Q和A的正则表达式
  const matches = text.matchAll(regex); // 获取所有匹配到的结果

  const result: PushDatasetDataChunkProps[] = []; // 存储最终的结果
  for (const match of matches) {
    const q = match[2] || '';
    const a = match[5] || '';
    if (q) {
      result.push({
        q,
        a,
        indexes: [
          {
            defaultIndex: true,
            type: DatasetDataIndexTypeEnum.qa,
            text: `${q}\n${a.trim().replace(/\n\s*/g, '\n')}`
          }
        ]
      });
    }
  }

  // empty result. direct split chunk
  if (result.length === 0) {
    const splitRes = splitText2Chunks({ text: rawText, maxLen: 500 });
    splitRes.chunks.forEach((chunk) => {
      result.push({
        q: chunk,
        a: '',
        indexes: [
          {
            defaultIndex: true,
            type: DatasetDataIndexTypeEnum.chunk,
            text: chunk
          }
        ]
      });
    });
  }

  return result;
}
