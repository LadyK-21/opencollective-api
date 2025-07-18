import { expect } from 'chai';
import gqlV1 from 'fake-tag';
import gql from 'fake-tag';
import { describe, it } from 'mocha';
import { createSandbox } from 'sinon';

import { Collective, ConnectedAccount, Order, PaymentMethod, User } from '../../../../server/models';
import creditcard from '../../../../server/paymentProviders/stripe/creditcard';
import { randEmail } from '../../../stores';
import { data, graphqlQuery, graphqlQueryV2, resetTestDB } from '../../../utils';

const TIER_QUERY = gql`
  query Tier($id: Int!) {
    tier(tier: { legacyId: $id }) {
      id
      name
      orders {
        nodes {
          id
          description
          paymentMethod {
            name
          }
        }
      }
    }
  }
`;

const CREATE_ORDER_MUTATION = gql`
  mutation CreateOrder($order: OrderCreateInput!) {
    createOrder(order: $order) {
      order {
        paymentMethod {
          name
        }
        fromAccount {
          id
          legacyId
        }
        createdByAccount {
          id
          legacyId
          ... on Individual {
            email
          }
        }
      }
    }
  }
`;

describe('server/graphql/v1/user', () => {
  let user1, user2, host, collective1, collective2, tier1, ticket1, sandbox;

  before(() => {
    sandbox = createSandbox();

    sandbox.stub(creditcard, 'processOrder').callsFake(order => {
      return Order.update({ processedAt: new Date() }, { where: { id: order.id } });
    });
  });

  after(() => sandbox.restore());

  beforeEach(() => resetTestDB());

  beforeEach(async () => {
    user1 = await User.createUserWithCollective(data('user1'));
  });
  beforeEach(async () => {
    user2 = await User.createUserWithCollective(data('user2'));
  });
  beforeEach(async () => {
    host = await User.createUserWithCollective(data('host1'));
  });

  beforeEach(async () => {
    collective1 = await Collective.create(data('collective1'));
  });

  beforeEach(async () => {
    collective2 = await Collective.create(data('collective2'));
  });

  beforeEach(async () => {
    tier1 = await collective1.createTier(data('tier1'));
  });
  beforeEach(async () => {
    ticket1 = await collective1.createTier(data('ticket1'));
  });

  beforeEach(() => collective1.addUserWithRole(user1, 'BACKER'));
  beforeEach(() => collective2.addUserWithRole(user1, 'ADMIN'));
  beforeEach(() => collective1.addHost(host.collective, host));

  beforeEach('create stripe account', () =>
    ConnectedAccount.create({
      service: 'stripe',
      token: 'abc',
      CollectiveId: host.id,
      username: 'stripeAccount',
    }),
  );

  describe('graphql.user.test.js', () => {
    describe('logged in user', () => {
      const loggedInUserQuery = gqlV1 /* GraphQL */ `
        query LoggedInUser {
          LoggedInUser {
            id
            memberOf {
              collective {
                slug
              }
              role
            }
          }
        }
      `;

      it('returns all collectives with role', async () => {
        const result = await graphqlQuery(loggedInUserQuery, null, user1);
        result.errors && console.error(result.errors);
        const data = result.data.LoggedInUser;
        expect(data.memberOf.length).to.equal(2);
        expect(data.memberOf[0].role).to.equal('BACKER');
        expect(data.memberOf[1].role).to.equal('ADMIN');
      });

      it("doesn't return anything if not logged in", async () => {
        const result = await graphqlQuery(loggedInUserQuery);
        result.errors && console.error(result.errors);
        const data = result.data.LoggedInUser;
        expect(data).to.be.null;
      });
    });

    describe('payment methods', () => {
      const generateLoggedInOrder = (tier = tier1) => {
        return {
          paymentMethod: {
            service: 'STRIPE',
            name: '4242',
            isSavedForLater: true,
            creditCardInfo: { token: 'tok_visa' },
          },
          amount: { valueInCents: tier.amount ?? 1000, currency: 'USD' },
          frequency: 'ONETIME',
          toAccount: { legacyId: collective1.id },
          tier: { legacyId: tier.id },
        };
      };

      const generateLoggedOutOrder = (tier = tier1) => {
        return {
          ...generateLoggedInOrder(tier),
        };
      };

      it('saves a payment method to the user', async () => {
        const result = await graphqlQueryV2(CREATE_ORDER_MUTATION, { order: generateLoggedInOrder() }, user1);
        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        const paymentMethods = await PaymentMethod.findAll({
          where: { CreatedByUserId: user1.id },
        });
        paymentMethods.errors && console.error(paymentMethods.errors);
        expect(paymentMethods).to.have.length(1);
        expect(paymentMethods[0].name).to.equal('4242');
        expect(paymentMethods[0].CollectiveId).to.equal(result.data.createOrder.order.fromAccount.legacyId);
      });

      it('does not save a payment method to the user', async () => {
        const order = generateLoggedInOrder();
        order.paymentMethod.isSavedForLater = false;
        const result = await graphqlQueryV2(CREATE_ORDER_MUTATION, { order }, user1);
        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        const paymentMethods = await PaymentMethod.findAll({
          where: { CreatedByUserId: user1.id },
        });
        expect(paymentMethods).to.have.length(1);
        expect(paymentMethods[0].CollectiveId).to.be.eq(user1.CollectiveId);
        expect(paymentMethods[0].saved).to.be.null;
      });

      it("doesn't get the payment method of the user if not logged in", async () => {
        const remoteUser = await User.createUserWithCollective({
          email: randEmail('user@opencollective.com'),
        });
        const resultCreateOrder = await graphqlQueryV2(
          CREATE_ORDER_MUTATION,
          {
            order: generateLoggedOutOrder(ticket1),
          },
          remoteUser,
        );
        resultCreateOrder.errors && console.error(resultCreateOrder.errors);
        expect(resultCreateOrder.errors).to.not.exist;

        const result = await graphqlQueryV2(TIER_QUERY, { id: ticket1.id });
        result.errors && console.error(result.errors);
        const orders = result.data.tier.orders.nodes;
        expect(orders).to.have.length(1);
        expect(orders[0].paymentMethod).to.be.null;
        const result2 = await graphqlQueryV2(TIER_QUERY, { id: ticket1.id }, user2);
        result2.errors && console.error(result2.errors);
        const orders2 = result2.data.tier.orders.nodes;
        expect(orders2).to.have.length(1);
        expect(orders2[0].paymentMethod).to.be.null;
      });

      it('gets the payment method of the user if logged in as that user', async () => {
        const order = generateLoggedInOrder();
        await graphqlQueryV2(CREATE_ORDER_MUTATION, { order }, user1);
        await PaymentMethod.update({ confirmedAt: new Date() }, { where: { CreatedByUserId: user1.id } });

        const result = await graphqlQueryV2(TIER_QUERY, { id: tier1.id }, user1);
        result.errors && console.error(result.errors);
        const orders = result.data.tier.orders.nodes;
        expect(orders).to.have.length(1);
        expect(orders[0].paymentMethod.name).to.equal('4242');
      });
    });
  });
});
