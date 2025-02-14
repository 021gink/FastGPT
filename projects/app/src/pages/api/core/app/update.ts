import type { NextApiRequest, NextApiResponse } from 'next';
import { jsonRes } from '@fastgpt/service/common/response';
import { connectToDatabase } from '@/service/mongo';
import { MongoApp } from '@fastgpt/service/core/app/schema';
import type { AppUpdateParams } from '@fastgpt/global/core/app/api';
import { authApp } from '@fastgpt/service/support/permission/auth/app';
import { SystemOutputEnum } from '@/constants/app';

/* 获取我的模型 */
export default async function handler(req: NextApiRequest, res: NextApiResponse<any>) {
  try {
    await connectToDatabase();
    const { name, avatar, type, intro, modules, permission } = req.body as AppUpdateParams;
    const { appId } = req.query as { appId: string };

    if (!appId) {
      throw new Error('appId is empty');
    }

    // 凭证校验
    await authApp({ req, authToken: true, appId, per: permission ? 'owner' : 'w' });

    // 更新模型
    await MongoApp.updateOne(
      {
        _id: appId
      },
      {
        name,
        type,
        avatar,
        intro,
        permission,
        ...(modules && {
          modules: modules.map((modules) => ({
            ...modules,
            outputs: modules.outputs.sort((a, b) => {
              // finish output always at last
              if (a.key === SystemOutputEnum.finish) return 1;
              if (b.key === SystemOutputEnum.finish) return -1;
              return 0;
            })
          }))
        })
      }
    );

    jsonRes(res);
  } catch (err) {
    jsonRes(res, {
      code: 500,
      error: err
    });
  }
}
