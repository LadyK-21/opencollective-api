import { GraphQLList, GraphQLNonNull } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import { flatten, uniq } from 'lodash';
import { Order } from 'sequelize';

import ActivityTypes, { ActivitiesPerClass } from '../../../../constants/activities';
import models, { Op } from '../../../../models';
import { checkRemoteUserCanUseAccount } from '../../../common/scope-check';
import { ActivityCollection } from '../../collection/ActivityCollection';
import { ActivityAttribution } from '../../enum/ActivityAttribution';
import { ActivityAndClassesType } from '../../enum/ActivityType';
import { AccountReferenceInput, fetchAccountWithReference } from '../../input/AccountReferenceInput';
import { CollectionArgs, CollectionReturnType } from '../../interface/Collection';

const IGNORED_ACTIVITIES: string[] = [ActivityTypes.COLLECTIVE_TRANSACTION_CREATED]; // This activity is creating a lot of noise, is usually covered already by orders/expenses activities and is not properly categorized (see https://github.com/opencollective/opencollective/issues/5903)

const ActivitiesCollectionArgs = {
  limit: { ...CollectionArgs.limit, defaultValue: 100 },
  offset: CollectionArgs.offset,
  account: {
    type: new GraphQLNonNull(AccountReferenceInput),
    description: 'The account associated with the Activity',
  },
  attribution: {
    type: ActivityAttribution,
    description: 'How activities are related to the account',
  },
  dateFrom: {
    type: GraphQLDateTime,
    defaultValue: null,
    description: 'Only return activities that were created after this date',
  },
  dateTo: {
    type: GraphQLDateTime,
    defaultValue: null,
    description: 'Only return activities that were created before this date',
  },
  type: {
    type: new GraphQLList(new GraphQLNonNull(ActivityAndClassesType)),
    defaultValue: null,
    description: 'Only return activities that are of this class/type',
  },
};

const ActivitiesCollectionQuery = {
  type: new GraphQLNonNull(ActivityCollection),
  args: ActivitiesCollectionArgs,
  async resolve(_: void, args, req): Promise<CollectionReturnType> {
    const { offset, limit } = args;
    const account = await fetchAccountWithReference(args.account, { throwIfMissing: true });

    // Check permissions
    checkRemoteUserCanUseAccount(req);
    if (!req.remoteUser.isAdminOfCollective(account) && !req.remoteUser.isRoot()) {
      return { nodes: null, totalCount: 0, limit, offset };
    }

    // Filter activities by account based on attribution. null = all related activities
    const accountOrConditions = [];
    const getDistinctFromCondition = value => ({ [Op.or]: [{ [Op.is]: null }, { [Op.ne]: value }] }); // Ideally, we should use `IS DISTINCT FROM` (https://wiki.postgresql.org/wiki/Is_distinct_from), but it's not supported by Sequelize yet: https://github.com/sequelize/sequelize/issues/12612

    if (!args.attribution) {
      accountOrConditions.push(
        { CollectiveId: account.id },
        { FromCollectiveId: account.id },
        { HostCollectiveId: account.id },
      );
    } else if (args.attribution === 'SELF') {
      accountOrConditions.push({ FromCollectiveId: account.id, CollectiveId: account.id });
    } else if (args.attribution === 'AUTHORED') {
      accountOrConditions.push({ FromCollectiveId: account.id, CollectiveId: getDistinctFromCondition(account.id) });
    } else if (args.attribution === 'RECEIVED') {
      accountOrConditions.push({ CollectiveId: account.id, FromCollectiveId: getDistinctFromCondition(account.id) });
    } else if (args.attribution === 'HOSTED_ACCOUNTS') {
      accountOrConditions.push({ HostCollectiveId: account.id });
    }

    // Other filters
    const where = { [Op.or]: accountOrConditions };
    if (args.dateFrom) {
      where['createdAt'] = { [Op.gte]: args.dateFrom };
    }
    if (args.dateTo) {
      where['createdAt'] = Object.assign({}, where['createdAt'], { [Op.lte]: args.dateTo });
    }
    if (args.type) {
      const selectedActivities: string[] = uniq(flatten(args.type.map(type => ActivitiesPerClass[type] || type)));
      where['type'] = selectedActivities.filter(type => !IGNORED_ACTIVITIES.includes(type));
    } else {
      where['type'] = { [Op.not]: IGNORED_ACTIVITIES };
    }

    const order: Order = [['createdAt', 'DESC']];
    const result = await models.Activity.findAndCountAll({ where, order, offset, limit });
    return {
      nodes: result.rows,
      totalCount: result.count,
      limit: args.limit,
      offset: args.offset,
    };
  },
};

export default ActivitiesCollectionQuery;